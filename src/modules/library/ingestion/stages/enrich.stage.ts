import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import {
  MetadataCandidate,
  FieldEvidence,
} from '@/modules/library/ingestion/types/metadata-candidate.types';
import {
  METADATA_PORT,
  MetadataPort,
} from '@/modules/library/ingestion/types/metadata.types';
import { NormalizationPolicy } from '@/modules/library/ingestion/policies/normalization.policy';
import { randomUUID } from 'crypto';
import {
  IWorkflowStage,
  EnrichStageInput,
} from '@/modules/library/ingestion/types/workflow-stage.types';

@Injectable()
export class EnrichStage implements IWorkflowStage<
  EnrichStageInput,
  MetadataCandidate[]
> {
  readonly stageName = 'ENRICH' as const;
  private readonly logger = new Logger(EnrichStage.name);

  constructor(
    @Optional()
    @Inject(METADATA_PORT)
    private readonly metadataService?: MetadataPort,
    private readonly normalizer?: NormalizationPolicy,
  ) {}

  /**
   * Executes external enrichment for candidates with recognized identifiers.
   * A PDF whose first page yields a credible title but no identifier is also
   * eligible for a title lookup. MetadataService validates title similarity
   * before accepting such a result, so a filename fallback cannot be promoted
   * into unrelated bibliographic data.
   */
  async execute(input: EnrichStageInput): Promise<MetadataCandidate[]> {
    const { scopeId, candidates } = input;

    if (!this.metadataService) {
      this.logger.debug(
        'MetadataService not available, skipping enrichment stage',
      );
      return candidates;
    }

    const enrichedCandidates = [...candidates];
    const seenQueries = new Set<string>();
    const isBulkRecordBatch =
      candidates.length > 1 &&
      candidates.every((c) => c.sourceKind === 'RECORD');

    const pendingTasks: Array<{
      candidate: MetadataCandidate;
      query: string;
    }> = [];

    for (const candidate of candidates) {
      const meta = candidate.normalizedMetadata || {};
      const extra = (meta.extraFields || {}) as Record<string, unknown>;
      const isFilenameTitle = extra.isFilenameTitle === true;
      const hasTitle = Boolean(
        !isFilenameTitle &&
        meta.title &&
        meta.title !== 'Untitled Document' &&
        meta.title !== 'Uploaded Document',
      );
      const hasAuthors = Boolean(
        (meta.authors && meta.authors.length > 0) ||
        (meta.creators && meta.creators.length > 0),
      );
      const hasYearOrDate = Boolean(
        meta.year ||
        meta.publicationDate ||
        meta.date ||
        extra.dateDecided ||
        extra.issueDate ||
        extra.filingDate ||
        extra.dateEnacted,
      );
      const hasAnyVenueOrSource = Boolean(
        meta.publicationTitle ||
        meta.journal ||
        meta.publisher ||
        meta.proceedingsTitle ||
        meta.conferenceName ||
        meta.bookTitle ||
        meta.university ||
        meta.institution ||
        meta.repository ||
        meta.issuingAuthority ||
        meta.court ||
        meta.code ||
        meta.websiteTitle ||
        meta.meetingName ||
        meta.programTitle ||
        meta.dictionaryTitle ||
        meta.encyclopediaTitle ||
        meta.forumTitle ||
        meta.blogTitle ||
        extra.proceedingsTitle ||
        extra.bookTitle ||
        extra.university ||
        extra.institution ||
        extra.repository ||
        extra.issuingAuthority ||
        extra.court ||
        extra.code ||
        extra.websiteTitle,
      );
      const hasVenueAndYear = Boolean(hasAnyVenueOrSource && hasYearOrDate);

      const doi = meta.doi;
      const arxivId = meta.arxivId;
      const pmid = meta.pmid;
      const isbn = meta.isbn;
      const url = meta.url;
      const hasAuthoritativeId = Boolean(doi || arxivId || pmid || isbn);

      // Official Zotero RecognizePDF standard:
      // 1. If a FILE candidate has an authoritative identifier (DOI, arXiv, PMID, ISBN),
      //    ALWAYS query external registries (Crossref/arXiv/PubMed/OpenAlex) so registry
      //    metadata populates canonical title, authors, venue, volume, issue, pages, abstract,
      //    and official subject/category tags.
      // 2. For non-FILE candidates (e.g. already-resolved PROVIDER or complete RECORD),
      //    skip enrichment when structured metadata is already complete.
      const isCompleteStructuredRecord =
        candidate.sourceKind === 'RECORD' &&
        hasTitle &&
        ((hasAuthors && hasYearOrDate) ||
          (isBulkRecordBatch && (hasAuthors || hasYearOrDate)));

      const isAlreadyComplete =
        candidate.sourceKind !== 'FILE' &&
        ((hasTitle &&
          hasAuthors &&
          hasVenueAndYear &&
          (candidate.confidenceScore ?? 0) >= 0.9) ||
          isCompleteStructuredRecord);

      if (isAlreadyComplete) {
        this.logger.debug(
          `[EnrichStage] Candidate ${candidate.candidateId} (source=${candidate.sourceName}, score=${candidate.confidenceScore}) has complete verified metadata. Skipping external API enrichment.`,
        );
        continue;
      }

      // If a FILE candidate has NO identifier and already has full venue + year + authors + title
      // from trusted in-process PDF extraction, skip noisy title-search fallback.
      // However, if venue/publicationTitle or tags are missing and the title is credible,
      // allow title-based registry lookup (validated by MetadataService title similarity).
      const hasExtractedTags = Boolean(
        (Array.isArray(meta.tags) && meta.tags.length > 0) ||
          (Array.isArray(meta.keywords) && meta.keywords.length > 0),
      );
      if (
        candidate.sourceKind === 'FILE' &&
        !hasAuthoritativeId &&
        (candidate.sourceName === 'TrustedPaper' ||
          meta.isSelfSufficient === true ||
          extra.isSelfSufficient === true) &&
        hasTitle &&
        hasAuthors &&
        hasVenueAndYear &&
        hasExtractedTags
      ) {
        this.logger.debug(
          `[EnrichStage] PDF candidate ${candidate.candidateId} has no identifier and already has complete local metadata including venue and tags. Skipping title search.`,
        );
        continue;
      }

      const title = meta.title?.trim();
      const isCredibleTitle =
        !isFilenameTitle &&
        Boolean(title) &&
        title!.length >= 10 &&
        !/\.(pdf|eps|png|jpe?g|svg)$/i.test(title!) &&
        !/^(uploaded document|untitled|document)$/i.test(title!) &&
        !/noname\s+manuscript/i.test(title!) &&
        !/\(will\s+be\s+inserted\s+by\s+the\s+editor\)/i.test(title!) &&
        !/^\d{4}\s*\d{4,5}(v\d+)?$/i.test(title!);
      const isSyntheticArxivDoi = Boolean(
        doi && /^10\.48550\/arxiv\./i.test(doi.trim()),
      );
      const query =
        (isSyntheticArxivDoi && arxivId ? arxivId : doi) ||
        arxivId ||
        pmid ||
        isbn ||
        (isCredibleTitle ? title : undefined) ||
        url;

      if (!query) continue;

      const normalizedQueryKey = query.trim().toLowerCase();
      if (seenQueries.has(normalizedQueryKey)) {
        continue;
      }
      seenQueries.add(normalizedQueryKey);

      pendingTasks.push({ candidate, query });
    }

    if (pendingTasks.length === 0) {
      return enrichedCandidates;
    }

    const metadataService = this.metadataService;
    const concurrency = Math.min(4, pendingTasks.length);
    let taskIndex = 0;

    const runWorker = async (): Promise<void> => {
      while (taskIndex < pendingTasks.length) {
        const currentIndex = taskIndex++;
        const task = pendingTasks[currentIndex];
        if (!task) break;
        const { candidate, query } = task;

        try {
          const resolved = await metadataService.resolve({
            query,
            scopeId,
          });

          if (resolved && resolved.metadata) {
            // A title-only lookup is a guess: an identically-titled chapter, talk or citing
            // paper by different authors must never replace the uploaded paper's record.
            if (
              resolved.queryType === 'TITLE' &&
              !this.sharesAuthors(candidate, resolved.metadata)
            ) {
              this.logger.warn(
                `Rejected title-only enrichment for "${query}": resolved authors do not match the uploaded document.`,
              );
              continue;
            }
            const rawMetadata = resolved.metadata;
            const normalized = this.normalizer
              ? this.normalizer.normalize(rawMetadata)
              : rawMetadata;

            const fields: Record<string, FieldEvidence> = {};

            for (const [fieldName, propertyValue] of Object.entries(
              normalized,
            )) {
              if (propertyValue !== undefined && propertyValue !== null) {
                const provenance = resolved.provenance[fieldName];
                fields[fieldName] = {
                  path: fieldName,
                  value: rawMetadata[fieldName as keyof typeof rawMetadata],
                  normalizedValue: propertyValue,
                  confidence: provenance ? provenance.confidence : 0.9,
                  sourceProvider: provenance
                    ? provenance.provider
                    : 'MetadataResolution',
                  retrievedAt: provenance
                    ? provenance.fetchedAt
                    : resolved.resolvedAt,
                };
              }
            }

            enrichedCandidates.push({
              candidateId: randomUUID(),
              sourceKind: 'PROVIDER',
              sourceName: 'EnrichedProvider',
              sourceRecordId: resolved.canonicalId,
              rawEvidenceRef: candidate.candidateId,
              retrievedAt: resolved.resolvedAt,
              schemaVersion: '1.0.0',
              fields,
              normalizedMetadata: normalized,
              confidenceScore: 0.95,
            });
          }
        } catch (caughtError: unknown) {
          const errorMessage =
            caughtError instanceof Error
              ? caughtError.message
              : String(caughtError);
          this.logger.warn(
            `Enrichment lookup failed for query "${query}": ${errorMessage}`,
          );
        }
      }
    };

    await Promise.all(Array.from({ length: concurrency }, () => runWorker()));

    return enrichedCandidates;
  }

  private static authorLastNames(authors: unknown): Set<string> {
    const names = new Set<string>();
    if (!Array.isArray(authors)) return names;
    for (const author of authors) {
      let last = '';
      if (typeof author === 'string') {
        last = author.trim().split(/\s+/).pop() ?? '';
      } else if (author && typeof author === 'object') {
        const a = author as Record<string, unknown>;
        last = String(
          a.lastName ?? a.family ?? a.name ?? a.fullName ?? '',
        )
          .trim()
          .split(/\s+/)
          .pop() as string;
      }
      last = last
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z]/g, '');
      if (last) names.add(last);
    }
    return names;
  }

  /**
   * True when the resolved record's author list agrees with the document's own
   * extracted authors (>= 50% last-name overlap). When either side has no authors
   * there is nothing to contradict, so the lookup is allowed.
   */
  private sharesAuthors(
    candidate: MetadataCandidate,
    resolved: unknown,
  ): boolean {
    const meta = candidate.normalizedMetadata || {};
    const own = EnrichStage.authorLastNames(meta.authors?.length ? meta.authors : meta.creators);
    const theirs = EnrichStage.authorLastNames(
      (resolved as { authors?: unknown; creators?: unknown }).authors ??
        (resolved as { creators?: unknown }).creators,
    );
    if (own.size === 0 || theirs.size === 0) return true;
    let shared = 0;
    for (const name of own) if (theirs.has(name)) shared++;
    return shared / Math.max(own.size, theirs.size) >= 0.5;
  }
}
