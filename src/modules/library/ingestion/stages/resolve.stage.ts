import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  MetadataCandidate, FieldEvidence, ReconciliationDecision, DuplicateMatchResult,
} from '@/modules/library/ingestion/types/metadata.types';
import { METADATA_PORT, MetadataPort } from '@/modules/library/ingestion/types/metadata.types';
import { NormalizationPolicy } from '@/modules/library/ingestion/policies/normalization.policy';
import { DuplicatePolicy } from '@/modules/library/ingestion/policies/metadata.policy';
import { IngestionVerifierService } from '@/modules/library/ingestion/services/ingestion-verifier.service';
import { calculateTitleSimilarity, tokenizeTitleWords } from '@/modules/library/ingestion/domain/deduplication.domain';
import { IWorkflowStage, ResolveStageInput, ResolveMatchInput } from '@/modules/library/ingestion/types/ingestion.types';
import {
  CATALOG_FACADE, ICatalogFacade, isPlaceholderItemTitle, ALIAS_EVIDENCE_FALLBACK_KEYS,
  MetadataCoalescePolicy, evaluateCitationTrap, extractNormalizedAuthorSurnames,
} from '@/modules/library/core';

const VENUE_METADATA_KEYS = [
  'publicationTitle', 'journal', 'publisher', 'proceedingsTitle', 'conferenceName',
  'bookTitle', 'university', 'institution', 'repository', 'issuingAuthority',
  'court', 'code', 'websiteTitle', 'meetingName', 'programTitle',
  'dictionaryTitle', 'encyclopediaTitle', 'forumTitle', 'blogTitle',
] as const;
const VENUE_EXTRA_KEYS = [
  'proceedingsTitle', 'bookTitle', 'university', 'institution', 'repository',
  'issuingAuthority', 'court', 'code', 'websiteTitle',
] as const;

export interface CandidateEnrichmentReadiness {
  shouldSkip: boolean;
  skipReason?: 'complete_or_client_resolved' | 'self_sufficient_pdf';
  isFilenameTitle: boolean;
  hasTitle: boolean;
  hasAuthors: boolean;
  hasYearOrDate: boolean;
  hasVenueAndYear: boolean;
  hasAuthoritativeId: boolean;
  hasExtractedTags: boolean;
  isCredibleTitle: boolean;
}

export function evaluateCandidateEnrichmentReadiness(
  candidate: MetadataCandidate,
  options?: { isBulkRecordBatch?: boolean },
): CandidateEnrichmentReadiness {
  const meta = (candidate.normalizedMetadata || {}) as Record<string, unknown>;
  const extra = ((meta.extraFields as Record<string, unknown>) || {}) as Record<string, unknown>;
  const isFilenameTitle = extra.isFilenameTitle === true;
  const rawTitle = typeof meta.title === 'string' ? meta.title : undefined;
  const hasTitle = Boolean(!isFilenameTitle && !isPlaceholderItemTitle(rawTitle));
  const hasAuthors = Boolean(
    (Array.isArray(meta.authors) && meta.authors.length > 0) || (Array.isArray(meta.creators) && meta.creators.length > 0),
  );
  const hasYearOrDate = Boolean(
    meta.year || meta.publicationDate || meta.date || extra.dateDecided || extra.issueDate || extra.filingDate || extra.dateEnacted,
  );
  const hasAnyVenueOrSource = VENUE_METADATA_KEYS.some((k) => Boolean(meta[k])) || VENUE_EXTRA_KEYS.some((k) => Boolean(extra[k]));
  const hasVenueAndYear = Boolean(hasAnyVenueOrSource && hasYearOrDate);
  const hasAuthoritativeId = Boolean(meta.doi || meta.arxivId || meta.pmid || meta.isbn);
  const hasAbstract = Boolean(meta.abstract && String(meta.abstract).trim().length > 20);
  const isBulkRecordBatch = Boolean(options?.isBulkRecordBatch);
  const isCompleteStructuredRecord =
    candidate.sourceKind === 'RECORD' && hasTitle &&
    ((hasAuthors && hasVenueAndYear && hasAbstract) || (isBulkRecordBatch && (hasAuthors || hasYearOrDate)));
  const isAlreadyComplete =
    candidate.sourceKind !== 'FILE' &&
    ((candidate.sourceKind !== 'RECORD' && hasTitle && hasAuthors && hasVenueAndYear && (candidate.confidenceScore ?? 0) >= 0.9) ||
      isCompleteStructuredRecord);
  const isClientResolved =
    extra.resolutionSource === 'client' || candidate.sourceName === 'ClientResolved' ||
    (candidate as unknown as { rawMetadata?: Record<string, unknown> })?.rawMetadata?.resolutionSource === 'client' ||
    meta.resolutionSource === 'client';
  const hasExtractedTags = Boolean(
    (Array.isArray(meta.tags) && meta.tags.length > 0) || (Array.isArray(meta.keywords) && meta.keywords.length > 0),
  );
  const isSelfSufficientPdf =
    candidate.sourceKind === 'FILE' && !hasAuthoritativeId &&
    (candidate.sourceName === 'TrustedPaper' || meta.isSelfSufficient === true || extra.isSelfSufficient === true) &&
    hasTitle && hasAuthors && hasVenueAndYear && hasExtractedTags;
  const trimmedTitle = rawTitle?.trim();
  const isCredibleTitle =
    !isFilenameTitle && Boolean(trimmedTitle) && trimmedTitle!.length >= 10 && !isPlaceholderItemTitle(trimmedTitle) &&
    !/\.(pdf|eps|png|jpe?g|svg)$/i.test(trimmedTitle!) && !/noname\s+manuscript/i.test(trimmedTitle!) &&
    !/\(will\s+be\s+inserted\s+by\s+the\s+editor\)/i.test(trimmedTitle!) && !/^\d{4}\s*\d{4,5}(v\d+)?$/i.test(trimmedTitle!);
  const base = { isFilenameTitle, hasTitle, hasAuthors, hasYearOrDate, hasVenueAndYear, hasAuthoritativeId, hasExtractedTags, isCredibleTitle };
  if (isAlreadyComplete || isClientResolved) return { shouldSkip: true, skipReason: 'complete_or_client_resolved', ...base };
  if (isSelfSufficientPdf) return { shouldSkip: true, skipReason: 'self_sufficient_pdf', ...base };
  return { shouldSkip: false, ...base };
}

export function selectCandidateEnrichmentQueries(candidate: MetadataCandidate, readiness: CandidateEnrichmentReadiness): string[] {
  if (readiness.shouldSkip) return [];
  const meta = (candidate.normalizedMetadata || {}) as Record<string, unknown>;
  const doi = typeof meta.doi === 'string' ? meta.doi : undefined;
  const arxivId = typeof meta.arxivId === 'string' ? meta.arxivId : undefined;
  const pmid = typeof meta.pmid === 'string' || typeof meta.pmid === 'number' ? String(meta.pmid) : undefined;
  const isbn = typeof meta.isbn === 'string' ? meta.isbn : undefined;
  const url = typeof meta.url === 'string' ? meta.url : undefined;
  const title = typeof meta.title === 'string' ? meta.title.trim() : undefined;
  const isSyntheticArxivDoi = Boolean(doi && /^10\.48550\/arxiv\./i.test(doi.trim()));
  const rawQuery = (isSyntheticArxivDoi && arxivId ? arxivId : doi) || arxivId || pmid || isbn || (readiness.isCredibleTitle ? title : undefined) || url;
  if (!rawQuery) return [];
  const query = String(rawQuery).trim();
  return query ? [query] : [];
}

@Injectable()
export class ResolveStage implements IWorkflowStage<ResolveStageInput, MetadataCandidate[]> {
  readonly stageName = 'RESOLVE' as const;
  private readonly logger = new Logger(ResolveStage.name);

  constructor(
    @Optional() @Inject(METADATA_PORT) private readonly metadataService?: MetadataPort,
    @Optional() private readonly normalizer?: NormalizationPolicy,
    @Optional() private readonly verifier?: IngestionVerifierService,
    @Optional() private readonly duplicatePolicy: DuplicatePolicy = new DuplicatePolicy(),
    @Optional() @Inject(CATALOG_FACADE) private readonly catalogGateway?: ICatalogFacade,
  ) {}

  async match(input: ResolveMatchInput): Promise<DuplicateMatchResult> {
    const { scope, proposedItem } = input;
    const actualProposed = proposedItem || {};
    const nestedMeta =
      'metadata' in actualProposed && actualProposed.metadata && typeof actualProposed.metadata === 'object'
        ? (actualProposed.metadata as Record<string, unknown>) : undefined;
    const normalizeStringField = (val: unknown): string | undefined => {
      if (typeof val === 'string') return val.trim().length > 0 ? val.trim() : undefined;
      if (typeof val === 'number') return String(val).trim();
      return undefined;
    };
    const proposedDoi = actualProposed.doi?.toLowerCase().trim();
    const cleanArxiv = normalizeStringField(actualProposed.arxivId) ?? normalizeStringField(nestedMeta?.arxivId);
    const cleanPmid = normalizeStringField(actualProposed.pmid) ?? normalizeStringField(nestedMeta?.pmid);
    const rawIsbn = normalizeStringField(actualProposed.isbn) ?? normalizeStringField(nestedMeta?.isbn);
    const cleanIsbn = rawIsbn ? rawIsbn.replace(/[-\s]/g, '') : undefined;
    const proposedTitle = actualProposed.title?.trim();
    const significantWords =
      proposedTitle && proposedTitle.length > 5 ? tokenizeTitleWords(proposedTitle).filter((w) => w.length >= 3).slice(0, 3) : [];

    if (this.catalogGateway?.findMatchCandidates) {
      const normalizedScope = typeof scope === 'string' ? { userId: scope } : scope;
      const proposedYear =
        actualProposed.year !== undefined && actualProposed.year !== null && Number.isFinite(Number(actualProposed.year))
          ? Number(actualProposed.year) : undefined;
      const matchResult = await this.catalogGateway.findMatchCandidates(normalizedScope, {
        doi: proposedDoi, arxivId: cleanArxiv, pmid: cleanPmid, isbn: cleanIsbn,
        year: proposedYear, titleWords: significantWords, titlePrefix: proposedTitle,
      });

      if (matchResult.exactMatch) {
        const existingTitle = matchResult.exactMatch.title?.trim();
        const isGenericTitle = (t?: string): boolean => !t || t.length <= 5 || isPlaceholderItemTitle(t);
        const titlesConflict =
          Boolean(proposedTitle) && Boolean(existingTitle) && !isGenericTitle(proposedTitle) &&
          !isGenericTitle(existingTitle) && calculateTitleSimilarity(proposedTitle ?? '', existingTitle ?? '') < 0.5;
        if (!titlesConflict) {
          return {
            matchType: 'EXACT', confidence: 1.0, targetItemId: matchResult.exactMatch.id,
            targetItemTitle: matchResult.exactMatch.title, matchReason: matchResult.exactMatch.matchReason,
            evidence: matchResult.exactMatch.evidence,
          };
        }
        this.logger.warn(`Ignored exact identifier match (${matchResult.exactMatch.matchReason}) due to conflicting titles: "${proposedTitle}" vs "${existingTitle}"`);
      }

      if (matchResult.candidateItems && matchResult.candidateItems.length > 0) {
        const sortedCandidates = [...matchResult.candidateItems].sort((a, b) => {
          const simB = calculateTitleSimilarity(proposedTitle ?? '', b.title ?? '');
          const simA = calculateTitleSimilarity(proposedTitle ?? '', a.title ?? '');
          if (simB !== simA) return simB - simA;
          if (proposedYear !== undefined) {
            const yearDiffA = a.year !== null && a.year !== undefined ? Math.abs(proposedYear - Number(a.year)) : 999;
            const yearDiffB = b.year !== null && b.year !== undefined ? Math.abs(proposedYear - Number(b.year)) : 999;
            return yearDiffA - yearDiffB;
          }
          return 0;
        });
        return this.duplicatePolicy.evaluate(actualProposed, sortedCandidates);
      }
      return { matchType: 'NO_MATCH', confidence: 0.0, matchReason: 'NONE' };
    }
    this.logger.warn('ResolveStage.match invoked without catalogGateway; skipping duplicate matching');
    return { matchType: 'NO_MATCH', confidence: 0.0, matchReason: 'NONE' };
  }

  async execute(input: ResolveStageInput): Promise<MetadataCandidate[]> {
    const { scopeId, candidates } = input;
    if (!this.metadataService) {
      this.logger.debug('MetadataService not available, skipping resolve stage');
      return candidates;
    }
    const enrichedCandidates = [...candidates];
    const seenQueries = new Map<string, { candidates: MetadataCandidate[]; query: string }>();
    const isBulkRecordBatch = candidates.length > 1 && candidates.every((c) => c.sourceKind === 'RECORD');
    const pendingTasks: Array<{ candidates: MetadataCandidate[]; query: string }> = [];

    for (const candidate of candidates) {
      const readiness = evaluateCandidateEnrichmentReadiness(candidate, { isBulkRecordBatch });
      if (readiness.shouldSkip) continue;
      for (const query of selectCandidateEnrichmentQueries(candidate, readiness)) {
        const normalizedQueryKey = query.toLowerCase();
        const existingTask = seenQueries.get(normalizedQueryKey);
        if (existingTask) {
          existingTask.candidates.push(candidate);
          continue;
        }
        const newTask = { candidates: [candidate], query };
        seenQueries.set(normalizedQueryKey, newTask);
        pendingTasks.push(newTask);
      }
    }
    if (pendingTasks.length === 0) return enrichedCandidates;

    const metadataService = this.metadataService;
    const concurrency = Math.min(4, pendingTasks.length);
    let taskIndex = 0;

    const runWorker = async (): Promise<void> => {
      while (taskIndex < pendingTasks.length) {
        const currentIndex = taskIndex++;
        const task = pendingTasks[currentIndex];
        if (!task) break;
        const { candidates: taskCandidates, query } = task;
        const primaryCandidate = taskCandidates[0];
        if (!primaryCandidate) continue;

        try {
          const resolved = await metadataService.resolve({ query, scopeId });
          if (resolved && resolved.metadata) {
            if (resolved.queryType === 'TITLE' && !this.sharesAuthors(primaryCandidate, resolved.metadata)) {
              this.logger.warn(`Rejected title-only enrichment for "${query}": resolved authors do not match the uploaded document.`);
              continue;
            }
            const rawMetadata = resolved.metadata;
            const normalized = this.normalizer ? this.normalizer.normalize(rawMetadata) : rawMetadata;
            const fields: Record<string, FieldEvidence> = {};
            const provenanceMap = (resolved.provenance || {}) as Record<
              string, { provider?: string; source?: string; sourceProvider?: string; confidence?: number; fetchedAt?: string }
            >;
            const metadataProv = (resolved.metadata as Record<string, unknown> | undefined)?.provenance as
              | { originProvider?: string; provider?: string; source?: string } | undefined;
            const fallbackProvider =
              metadataProv?.originProvider || metadataProv?.provider || metadataProv?.source ||
              (resolved as { sourceProvider?: string; provider?: string }).sourceProvider ||
              (resolved as { provider?: string }).provider || 'MetadataResolution';

            for (const [fieldName, propertyValue] of Object.entries(normalized)) {
              if (propertyValue !== undefined && propertyValue !== null) {
                let provenance = provenanceMap[fieldName];
                if (!provenance) {
                  for (const fk of ALIAS_EVIDENCE_FALLBACK_KEYS[fieldName] || []) {
                    if (provenanceMap[fk]) { provenance = provenanceMap[fk]; break; }
                  }
                }
                const resolvedFieldProvider = provenance?.provider || provenance?.sourceProvider || provenance?.source || fallbackProvider;
                fields[fieldName] = {
                  path: fieldName,
                  value: rawMetadata[fieldName as keyof typeof rawMetadata] !== undefined ? rawMetadata[fieldName as keyof typeof rawMetadata] : propertyValue,
                  normalizedValue: propertyValue,
                  confidence: provenance && typeof provenance.confidence === 'number' ? provenance.confidence : 0.9,
                  sourceProvider: resolvedFieldProvider,
                  retrievedAt: provenance?.fetchedAt || resolved.resolvedAt || new Date().toISOString(),
                };
              }
            }

            for (const matchedCandidate of taskCandidates) {
              const filteredFields: Record<string, FieldEvidence> = {};
              const filteredMeta: Record<string, unknown> = {};
              for (const [k, ev] of Object.entries(fields)) {
                const origEv = matchedCandidate.fields?.[k];
                if (origEv?.sourceProvider === 'UserOverride' || origEv?.sourceProvider === 'manual') continue;
                filteredFields[k] = ev;
                filteredMeta[k] = ev.normalizedValue ?? normalized[k as keyof typeof normalized];
              }
              for (const [mk, mv] of Object.entries(normalized)) {
                if (mv !== undefined && mv !== null && !(mk in filteredMeta)) {
                  const origEv = matchedCandidate.fields?.[mk];
                  if (origEv?.sourceProvider !== 'UserOverride' && origEv?.sourceProvider !== 'manual') filteredMeta[mk] = mv;
                }
              }
              enrichedCandidates.push({
                candidateId: randomUUID(), sourceKind: 'PROVIDER', sourceName: fallbackProvider || 'EnrichedProvider',
                sourceRecordId: resolved.canonicalId, rawEvidenceRef: matchedCandidate.candidateId,
                retrievedAt: resolved.resolvedAt, schemaVersion: '1.0.0', fields: filteredFields,
                normalizedMetadata: filteredMeta, confidenceScore: 0.95,
              });
            }
          }
        } catch (caughtError: unknown) {
          this.logger.warn(`Enrichment lookup failed for query "${query}": ${caughtError instanceof Error ? caughtError.message : String(caughtError)}`);
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, () => runWorker()));
    return enrichedCandidates;
  }

  coalesceAndVerify(candidates: MetadataCandidate[]): Promise<ReconciliationDecision> {
    for (const cand of candidates) {
      if (!cand.fields || Object.keys(cand.fields).length === 0) {
        cand.fields = {};
        for (const [k, v] of Object.entries(cand.normalizedMetadata || {})) {
          if (v !== undefined && v !== null) {
            cand.fields[k] = {
              path: k, value: v, normalizedValue: v, confidence: cand.confidenceScore || 0.9,
              sourceProvider: cand.sourceName, retrievedAt: cand.retrievedAt || new Date().toISOString(),
            };
          }
        }
      }
    }

    let activeCandidates = [...candidates];
    const fileCandidate = activeCandidates.find(
      (c) => c.sourceKind === 'FILE' || c.sourceName === 'TrustedPaper' || c.sourceName === 'StagedPdf',
    );
    let citationTrapRejectedDoi: string | undefined;
    const isFilenameFallback =
      Boolean(
        fileCandidate?.fields?.extraFields?.normalizedValue &&
          typeof fileCandidate.fields.extraFields.normalizedValue === 'object' &&
          (fileCandidate.fields.extraFields.normalizedValue as Record<string, unknown>).isFilenameTitle,
      ) || Boolean(fileCandidate?.normalizedMetadata?.extraFields?.isFilenameTitle);

    if (fileCandidate && fileCandidate.normalizedMetadata?.title && !isFilenameFallback) {
      const remaining: MetadataCandidate[] = [];
      for (const cand of activeCandidates) {
        if ((cand.sourceKind === 'PROVIDER' || cand.sourceName === 'EnrichedProvider') && cand.normalizedMetadata?.title) {
          const trap = evaluateCitationTrap(
            fileCandidate.normalizedMetadata as Record<string, unknown>,
            cand.normalizedMetadata as Record<string, unknown>,
            isFilenameFallback,
          );
          if (trap.isTrap) {
            citationTrapRejectedDoi = trap.rejectedDoi;
            this.logger.warn(
              `[ResolveStage] Page-1 Citation Disambiguation Mismatch: Discarding external candidate ${cand.candidateId} (title="${cand.normalizedMetadata.title}") which conflicts with local PDF title "${fileCandidate.normalizedMetadata.title}" (similarity=${(trap.similarity * 100).toFixed(0)}%).`,
            );
            continue;
          }
        }
        remaining.push(cand);
      }
      activeCandidates = remaining;

      if (citationTrapRejectedDoi) {
        const survivingHasDoi = activeCandidates.some(
          (c) => c !== fileCandidate && c.normalizedMetadata?.doi && c.normalizedMetadata.doi.toLowerCase() === citationTrapRejectedDoi!.toLowerCase(),
        );
        if (fileCandidate.normalizedMetadata) {
          if (!survivingHasDoi) delete fileCandidate.normalizedMetadata.doi;
          fileCandidate.normalizedMetadata.extraFields = {
            ...(fileCandidate.normalizedMetadata.extraFields || {}),
            disambiguationWarning: 'Page-1 cited paper DOI mismatch discarded. Preserved original PDF layout metadata.',
            rejectedCitedDoi: citationTrapRejectedDoi,
          };
        }
        if (fileCandidate.fields?.doi && !survivingHasDoi) delete fileCandidate.fields.doi;
      }
    }

    const decision = MetadataCoalescePolicy.coalesceCandidates(activeCandidates);
    if (!this.verifier) return Promise.resolve(decision);

    const proposed = decision.proposedItem;
    if (citationTrapRejectedDoi) {
      const survivingMatchesProposedDoi = activeCandidates.some(
        (c) => c !== fileCandidate && c.normalizedMetadata?.doi && proposed.doi && c.normalizedMetadata.doi.toLowerCase() === String(proposed.doi).toLowerCase(),
      );
      if (!survivingMatchesProposedDoi && (!proposed.doi || String(proposed.doi).toLowerCase() === citationTrapRejectedDoi.toLowerCase())) {
        delete proposed.doi;
      }
      proposed.extraFields = {
        ...(proposed.extraFields || {}),
        disambiguationWarning: 'Page-1 cited paper DOI mismatch discarded. Preserved original PDF layout metadata.',
        rejectedCitedDoi: citationTrapRejectedDoi,
      };
    }

    const urlCandidate = activeCandidates.find((c) => c.sourceKind === 'URL');
    const externalCandidates = activeCandidates.filter((c) => c.sourceKind === 'PROVIDER' || c.sourceName === 'EnrichedProvider');
    const isBlocked = Boolean(urlCandidate?.normalizedMetadata?.extraFields?.isBlocked) || Boolean(proposed?.extraFields?.isBlocked);
    if (isBlocked) {
      const wafKind = (urlCandidate?.normalizedMetadata?.extraFields?.wafKind as string) || (proposed?.extraFields?.wafKind as string) || 'WAF_BOT_CHALLENGE';
      proposed.extraFields = {
        ...(proposed.extraFields || {}), ingestionStatus: 'BLOCKED', wafKind, promptUploadPdf: true, verificationScore: 0.0, isVerified: false,
        warnings: ['Source is protected by anti-bot WAF / Cloudflare Turnstile. Please upload the PDF directly.'],
      };
      return Promise.resolve(decision);
    }

    const verifyResult =
      fileCandidate && (externalCandidates.length > 0 || urlCandidate)
        ? this.verifier.verifyWebCandidate(this.verifier.extractFingerprint(fileCandidate.normalizedMetadata), proposed, 'multi_provider_reconcile')
        : fileCandidate
          ? this.verifier.evaluateLocalResult(
              proposed,
              typeof fileCandidate.normalizedMetadata?.engineUsed === 'string' && fileCandidate.normalizedMetadata.engineUsed.trim()
                ? fileCandidate.normalizedMetadata.engineUsed.trim()
                : fileCandidate.sourceName === 'TrustedPaper' ? 'LOCAL_IN_PROCESS' : 'StagedPdf',
              typeof fileCandidate.normalizedMetadata?.qualityScore === 'number'
                ? fileCandidate.normalizedMetadata.qualityScore
                : typeof fileCandidate.confidenceScore === 'number' ? fileCandidate.confidenceScore : 0.85,
            )
          : this.verifier.evaluateLocalResult(proposed, candidates[0]?.sourceName || 'DirectIdentifier', candidates[0]?.confidenceScore || 0.9);

    proposed.extraFields = {
      ...(proposed.extraFields || {}), ingestionStatus: verifyResult.status, verificationScore: verifyResult.verificationScore,
      isVerified: verifyResult.isVerified, fieldProvenance: { ...verifyResult.fieldProvenance, ...(proposed.extraFields?.fieldProvenance || {}) },
      matchedSignals: verifyResult.matchedSignals, missingFields: verifyResult.missingFields, warnings: verifyResult.warnings,
    };
    return Promise.resolve(decision);
  }

  reconcile(candidates: MetadataCandidate[]): Promise<ReconciliationDecision> { return this.coalesceAndVerify(candidates); }
  resolveCandidateDecision(candidates: MetadataCandidate[]): Promise<ReconciliationDecision> { return this.coalesceAndVerify(candidates); }

  private sharesAuthors(candidate: MetadataCandidate, resolved: unknown): boolean {
    const meta = candidate.normalizedMetadata || {};
    const own = extractNormalizedAuthorSurnames(meta.authors?.length ? meta.authors : meta.creators);
    const theirs = extractNormalizedAuthorSurnames(
      (resolved as { authors?: unknown; creators?: unknown }).authors ?? (resolved as { creators?: unknown }).creators,
    );
    if (own.size === 0 || theirs.size === 0) return true;
    let shared = 0;
    for (const name of own) if (theirs.has(name)) shared++;
    return shared / Math.min(own.size, theirs.size) >= 0.5;
  }
}
