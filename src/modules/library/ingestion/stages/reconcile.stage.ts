import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  MetadataCandidate,
  ReconciliationDecision,
} from '../types/metadata-candidate.types';
import { ReconciliationPolicy } from '../policies/reconciliation.policy';
import { IngestionVerifierService } from '../services/ingestion-verifier.service';

@Injectable()
export class ReconcileStage {
  private readonly logger = new Logger(ReconcileStage.name);

  constructor(
    private readonly reconciler: ReconciliationPolicy,
    @Optional() private readonly verifier?: IngestionVerifierService,
  ) {}

  /**
   * Executes deterministic reconciliation over candidates and performs
   * verification scoring against the PDF fingerprint or local heuristics.
   */
  async execute(candidates: MetadataCandidate[]): Promise<ReconciliationDecision> {
    // Ensure all candidates have fields populated from normalizedMetadata if empty
    for (const cand of candidates) {
      if (!cand.fields || Object.keys(cand.fields).length === 0) {
        cand.fields = {};
        for (const [k, v] of Object.entries(cand.normalizedMetadata || {})) {
          if (v !== undefined && v !== null && k !== 'extraFields') {
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

    const decision = this.reconciler.reconcile(candidates);
    if (!this.verifier) {
      return decision;
    }

    const proposed = decision.proposedItem;
    const fileCandidate = candidates.find(
      (c) =>
        c.sourceKind === 'FILE' ||
        c.sourceName === 'TrustedPaper' ||
        c.sourceName === 'StagedPdf',
    );
    const urlCandidate = candidates.find((c) => c.sourceKind === 'URL');
    const externalCandidates = candidates.filter(
      (c) =>
        c.sourceKind === 'PROVIDER' ||
        c.sourceName === 'EnrichedProvider',
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
      return decision;
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
          ...((proposed.extraFields?.fieldProvenance as Record<string, any>) || {}),
          ...verifyResult.fieldProvenance,
        },
        matchedSignals: verifyResult.matchedSignals,
        missingFields: verifyResult.missingFields,
        warnings: verifyResult.warnings,
      };
      return decision;
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
          ...((proposed.extraFields?.fieldProvenance as Record<string, any>) || {}),
          ...verifyResult.fieldProvenance,
        },
        matchedSignals: verifyResult.matchedSignals,
        missingFields: verifyResult.missingFields,
        warnings: verifyResult.warnings,
      };
      return decision;
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
        ...((proposed.extraFields?.fieldProvenance as Record<string, any>) || {}),
        ...verifyResult.fieldProvenance,
      },
      matchedSignals: verifyResult.matchedSignals,
      missingFields: verifyResult.missingFields,
      warnings: verifyResult.warnings,
    };

    return decision;
  }
}
