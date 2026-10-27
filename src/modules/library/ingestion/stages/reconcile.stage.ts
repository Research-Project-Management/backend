import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  MetadataCandidate,
  ReconciliationDecision,
} from '@/modules/library/ingestion/types/metadata-candidate.types';
import { ReconciliationPolicy } from '@/modules/library/ingestion/policies/reconciliation.policy';
import { IngestionVerifierService } from '@/modules/library/ingestion/services/ingestion-verifier.service';
import { IWorkflowStage } from '@/modules/library/ingestion/types/workflow-stage.types';
import {
  isPlaceholderItemTitle,
  titleSimilarity,
} from '@/modules/library/core';

@Injectable()
export class ReconcileStage implements IWorkflowStage<
  MetadataCandidate[],
  ReconciliationDecision
> {
  readonly stageName = 'RECONCILE' as const;
  private readonly logger = new Logger(ReconcileStage.name);

  constructor(
    private readonly reconciler: ReconciliationPolicy,
    @Optional() private readonly verifier?: IngestionVerifierService,
  ) {}

  /**
   * Executes deterministic reconciliation over candidates and performs
   * verification scoring against the PDF fingerprint or local heuristics.
   */
  execute(candidates: MetadataCandidate[]): Promise<ReconciliationDecision> {
    // Ensure all candidates have fields populated from normalizedMetadata if empty
    for (const cand of candidates) {
      if (!cand.fields || Object.keys(cand.fields).length === 0) {
        cand.fields = {};
        for (const [k, v] of Object.entries(cand.normalizedMetadata || {})) {
          if (v !== undefined && v !== null) {
            cand.fields[k] = {
              path: k,
              value: v,
              normalizedValue: v,
              confidence: cand.confidenceScore || 0.9,
              sourceProvider: cand.sourceName,
              retrievedAt: cand.retrievedAt || new Date().toISOString(),
            };
          }
        }
      }
    }

    let activeCandidates = [...candidates];
    const fileCandidate = activeCandidates.find(
      (c) =>
        c.sourceKind === 'FILE' ||
        c.sourceName === 'TrustedPaper' ||
        c.sourceName === 'StagedPdf',
    );

    // Page-1 Citation Disambiguation Pre-filtering:
    // If we have an authentic local PDF extraction with a credible title,
    // verify that external enriched candidates do not belong to a cited paper.
    let citationTrapRejectedDoi: string | undefined;
    const isFilenameFallback = Boolean(
      fileCandidate?.fields?.extraFields?.normalizedValue &&
        typeof fileCandidate.fields.extraFields.normalizedValue === 'object' &&
        (fileCandidate.fields.extraFields.normalizedValue as Record<string, unknown>).isFilenameTitle,
    ) || Boolean(
      fileCandidate?.normalizedMetadata?.extraFields?.isFilenameTitle,
    );

    if (fileCandidate && fileCandidate.normalizedMetadata?.title && !isFilenameFallback) {
      const fileTitle = fileCandidate.normalizedMetadata.title;
      const isCrediblePdfTitle =
        fileTitle.trim().length >= 10 &&
        !isPlaceholderItemTitle(fileTitle) &&
        !/^manuscript$/i.test(fileTitle.trim()) &&
        !/^\d{4}\s*\d{4,5}(v\d+)?$/i.test(fileTitle.trim()) &&
        !/^arxiv/i.test(fileTitle.trim());

      if (isCrediblePdfTitle) {
        const remaining: MetadataCandidate[] = [];
        for (const cand of activeCandidates) {
          if (
            (cand.sourceKind === 'PROVIDER' ||
              cand.sourceName === 'EnrichedProvider') &&
            cand.normalizedMetadata?.title
          ) {
            const sim = titleSimilarity(
              cand.normalizedMetadata.title,
              fileTitle,
            );
            if (sim < 0.4) {
              citationTrapRejectedDoi =
                cand.normalizedMetadata.doi ||
                fileCandidate.normalizedMetadata?.doi;
              this.logger.warn(
                `[ReconcileStage] Page-1 Citation Disambiguation Mismatch: Discarding external candidate ${cand.candidateId} (title="${cand.normalizedMetadata.title}") which conflicts with local PDF title "${fileTitle}" (similarity=${(sim * 100).toFixed(0)}%).`,
              );
              continue; // Drop the cited paper candidate!
            }
          }
          remaining.push(cand);
        }
        activeCandidates = remaining;

        if (citationTrapRejectedDoi) {
          if (fileCandidate.normalizedMetadata) {
            if (
              !activeCandidates.some(
                (c) =>
                  c !== fileCandidate &&
                  c.normalizedMetadata?.doi &&
                  c.normalizedMetadata.doi.toLowerCase() ===
                    citationTrapRejectedDoi!.toLowerCase(),
              )
            ) {
              delete fileCandidate.normalizedMetadata.doi;
            }
            fileCandidate.normalizedMetadata.extraFields = {
              ...(fileCandidate.normalizedMetadata.extraFields || {}),
              disambiguationWarning:
                'Page-1 cited paper DOI mismatch discarded. Preserved original PDF layout metadata.',
              rejectedCitedDoi: citationTrapRejectedDoi,
            };
          }
          if (fileCandidate.fields?.doi) {
            if (
              !activeCandidates.some(
                (c) =>
                  c !== fileCandidate &&
                  c.normalizedMetadata?.doi &&
                  c.normalizedMetadata.doi.toLowerCase() ===
                    citationTrapRejectedDoi!.toLowerCase(),
              )
            ) {
              delete fileCandidate.fields.doi;
            }
          }
        }
      }
    }

    const decision = this.reconciler.reconcile(activeCandidates);
    if (!this.verifier) {
      return Promise.resolve(decision);
    }

    const proposed = decision.proposedItem;
    if (citationTrapRejectedDoi) {
      const survivingMatchesProposedDoi = activeCandidates.some(
        (c) =>
          c !== fileCandidate &&
          c.normalizedMetadata?.doi &&
          proposed.doi &&
          c.normalizedMetadata.doi.toLowerCase() ===
            String(proposed.doi).toLowerCase(),
      );
      if (
        !survivingMatchesProposedDoi &&
        (!proposed.doi ||
          String(proposed.doi).toLowerCase() ===
            citationTrapRejectedDoi.toLowerCase())
      ) {
        delete proposed.doi;
      }
      proposed.extraFields = {
        ...(proposed.extraFields || {}),
        disambiguationWarning:
          'Page-1 cited paper DOI mismatch discarded. Preserved original PDF layout metadata.',
        rejectedCitedDoi: citationTrapRejectedDoi,
      };
    }

    const urlCandidate = activeCandidates.find((c) => c.sourceKind === 'URL');
    const externalCandidates = activeCandidates.filter(
      (c) => c.sourceKind === 'PROVIDER' || c.sourceName === 'EnrichedProvider',
    );

    // 1. Check if input was blocked by WAF/Bot challenge
    const isBlocked =
      Boolean(urlCandidate?.normalizedMetadata?.extraFields?.isBlocked) ||
      Boolean(proposed?.extraFields?.isBlocked);

    if (isBlocked) {
      const wafKind =
        (urlCandidate?.normalizedMetadata?.extraFields?.wafKind as string) ||
        (proposed?.extraFields?.wafKind as string) ||
        'WAF_BOT_CHALLENGE';

      proposed.extraFields = {
        ...(proposed.extraFields || {}),
        ingestionStatus: 'BLOCKED',
        wafKind,
        promptUploadPdf: true,
        verificationScore: 0.0,
        isVerified: false,
        warnings: [
          'Source is protected by anti-bot WAF / Cloudflare Turnstile. Please upload the PDF directly.',
        ],
      };
      return Promise.resolve(decision);
    }

    // 2. Local PDF with external web candidate verification
    if (fileCandidate && (externalCandidates.length > 0 || urlCandidate)) {
      const fingerprint = this.verifier.extractFingerprint(
        fileCandidate.normalizedMetadata,
      );
      const verifyResult = this.verifier.verifyWebCandidate(
        fingerprint,
        proposed,
        'multi_provider_reconcile',
      );

      proposed.extraFields = {
        ...(proposed.extraFields || {}),
        ingestionStatus: verifyResult.status,
        verificationScore: verifyResult.verificationScore,
        isVerified: verifyResult.isVerified,
        fieldProvenance: {
          ...verifyResult.fieldProvenance,
          ...(proposed.extraFields?.fieldProvenance || {}),
        },
        matchedSignals: verifyResult.matchedSignals,
        missingFields: verifyResult.missingFields,
        warnings: verifyResult.warnings,
      };
      return Promise.resolve(decision);
    }

    // 3. Local PDF alone (no external enrichment or self-sufficient)
    if (fileCandidate) {
      const rawQuality = fileCandidate.normalizedMetadata?.qualityScore;
      const qualityScore =
        typeof rawQuality === 'number'
          ? rawQuality
          : typeof fileCandidate.confidenceScore === 'number'
            ? fileCandidate.confidenceScore
            : 0.85;
      const rawEngine = fileCandidate.normalizedMetadata?.engineUsed;
      const engineUsed =
        typeof rawEngine === 'string' && rawEngine.trim()
          ? rawEngine.trim()
          : fileCandidate.sourceName === 'TrustedPaper'
            ? 'LOCAL_IN_PROCESS'
            : 'StagedPdf';

      const verifyResult = this.verifier.evaluateLocalResult(
        proposed,
        engineUsed,
        qualityScore,
      );

      proposed.extraFields = {
        ...(proposed.extraFields || {}),
        ingestionStatus: verifyResult.status,
        verificationScore: verifyResult.verificationScore,
        isVerified: verifyResult.isVerified,
        fieldProvenance: {
          ...verifyResult.fieldProvenance,
          ...(proposed.extraFields?.fieldProvenance || {}),
        },
        matchedSignals: verifyResult.matchedSignals,
        missingFields: verifyResult.missingFields,
        warnings: verifyResult.warnings,
      };
      return Promise.resolve(decision);
    }

    // 4. URL or Identifier or Record alone
    const sourceProvider = candidates[0]?.sourceName || 'DirectIdentifier';
    const baseConf = candidates[0]?.confidenceScore || 0.9;
    const verifyResult = this.verifier.evaluateLocalResult(
      proposed,
      sourceProvider,
      baseConf,
    );

    proposed.extraFields = {
      ...(proposed.extraFields || {}),
      ingestionStatus: verifyResult.status,
      verificationScore: verifyResult.verificationScore,
      isVerified: verifyResult.isVerified,
      fieldProvenance: {
        ...verifyResult.fieldProvenance,
        ...(proposed.extraFields?.fieldProvenance || {}),
      },
      matchedSignals: verifyResult.matchedSignals,
      missingFields: verifyResult.missingFields,
      warnings: verifyResult.warnings,
    };

    return Promise.resolve(decision);
  }
}
