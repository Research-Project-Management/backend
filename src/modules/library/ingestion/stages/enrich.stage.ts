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
  EnrichStageInput | string,
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
  async execute(
    scopeIdOrInput: string | EnrichStageInput,
    candidatesArg?: MetadataCandidate[],
  ): Promise<MetadataCandidate[]> {
    const scopeId =
      typeof scopeIdOrInput === 'string'
        ? scopeIdOrInput
        : scopeIdOrInput.scopeId;
    const candidates =
      typeof scopeIdOrInput === 'string'
        ? candidatesArg || []
        : scopeIdOrInput.candidates;

    if (!this.metadataService) {
      this.logger.debug(
        'MetadataService not available, skipping enrichment stage',
      );
      return candidates;
    }

    const enrichedCandidates = [...candidates];
    const seenQueries = new Set<string>();

    for (const candidate of candidates) {
      const hasTitle = Boolean(
        candidate.normalizedMetadata?.title &&
        candidate.normalizedMetadata.title !== 'Untitled Document' &&
        candidate.normalizedMetadata.title !== 'Uploaded Document',
      );
      const hasAuthors = Boolean(
        candidate.normalizedMetadata?.authors &&
        candidate.normalizedMetadata.authors.length > 0,
      );

      // Only skip external enrichment if the candidate ALREADY has complete verified metadata
      // (both title and authors, or marked self-sufficient by local trusted extraction).
      // Bare identifiers without a title must always be resolved via authoritative doi.org/providers.
      const isAlreadyComplete =
        candidate.sourceName === 'TrustedPaper' ||
        candidate.normalizedMetadata?.extraFields?.isSelfSufficient === true ||
        candidate.normalizedMetadata?.isSelfSufficient === true ||
        (hasTitle && hasAuthors && (candidate.confidenceScore ?? 0) >= 0.85) ||
        (hasTitle &&
          Boolean(
            candidate.normalizedMetadata?.doi ||
            candidate.normalizedMetadata?.arxivId,
          ) &&
          (candidate.confidenceScore ?? 0) >= 0.75);

      if (isAlreadyComplete) {
        this.logger.debug(
          `[EnrichStage] Candidate ${candidate.candidateId} (source=${candidate.sourceName}, score=${candidate.confidenceScore}) has sufficient local/verified metadata. Skipping external API enrichment.`,
        );
        continue;
      }

      const doi = candidate.normalizedMetadata.doi;
      const arxivId = candidate.normalizedMetadata.arxivId;
      const pmid = candidate.normalizedMetadata.pmid;
      const isbn = candidate.normalizedMetadata.isbn;
      const url = candidate.normalizedMetadata.url;
      const title = candidate.normalizedMetadata.title?.trim();
      const isCredibleTitle =
        Boolean(title) &&
        title!.length >= 10 &&
        !/\.(pdf|eps|png|jpe?g|svg)$/i.test(title!) &&
        !/^(uploaded document|untitled|document)$/i.test(title!) &&
        !/noname\s+manuscript/i.test(title!) &&
        !/\(will\s+be\s+inserted\s+by\s+the\s+editor\)/i.test(title!) &&
        !/^\d{4}\s*\d{4,5}(v\d+)?$/i.test(title!);
      const query =
        doi ||
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

      if (candidates.length > 1) {
        await new Promise((resolve) => setTimeout(resolve, 150));
      }

      try {
        const resolved = await this.metadataService.resolve({
          query,
          scopeId,
        });

        if (resolved && resolved.metadata) {
          const rawMetadata = resolved.metadata;
          const normalized = this.normalizer
            ? this.normalizer.normalize(rawMetadata)
            : rawMetadata;

          const fields: Record<string, FieldEvidence> = {};

          for (const [fieldName, propertyValue] of Object.entries(normalized)) {
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

    return enrichedCandidates;
  }
}
