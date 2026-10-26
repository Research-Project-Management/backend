import {
  MetadataCandidate,
  FieldEvidence,
  ReconciliationDecision,
  MetadataConflictDetail,
} from '@/modules/library/ingestion/types/metadata-candidate.types';
import {
  SOURCE_WEIGHTS,
  resolveProviderFieldWeight,
  selectAuthoritativeCreatorVariant,
  mergeReconciledTagArrays,
  mergeReconciledNotesArrays,
  finalizeReconciledBibliographicMetadata,
} from '@/modules/library/ingestion/services/metadata-reconciliation.service';

export class ReconciliationPolicy {
  /**
   * Global fallback provider priority scores for ingestion-pipeline reconciliation,
   * derived from the unified SOURCE_WEIGHTS & FIELD_AUTHORITY_WEIGHTS hierarchy.
   */
  private static readonly PROVIDER_PRIORITY: Record<string, number> =
    Object.fromEntries(
      Object.entries(SOURCE_WEIGHTS).map(([k, v]) => [k, Math.round(v * 100)]),
    );

  private static getProviderPriority(provider: string, field?: string): number {
    return resolveProviderFieldWeight(provider, field) * 100;
  }

  /**
   * Reconciles multiple candidates into a single canonical proposal with full field provenance.
   */
  reconcile(candidates: MetadataCandidate[]): ReconciliationDecision {
    if (!candidates || candidates.length === 0) {
      return {
        selectedFields: {},
        rejectedFields: {},
        conflicts: [],
        proposedItem: { title: 'Untitled Record' },
        decidedAt: new Date().toISOString(),
        policyVersion: '1.1.0',
      };
    }

    // Collect all field variants across candidates
    const fieldMap = new Map<string, FieldEvidence[]>();

    for (const candidate of candidates) {
      for (const [key, evidence] of Object.entries(candidate.fields)) {
        if (
          !evidence ||
          evidence.normalizedValue === undefined ||
          evidence.normalizedValue === null
        ) {
          continue;
        }
        const existing = fieldMap.get(key) || [];
        existing.push(evidence);
        fieldMap.set(key, existing);
      }
    }

    const selectedFields: Record<string, FieldEvidence> = {};
    const rejectedFields: Record<string, FieldEvidence[]> = {};
    const conflicts: MetadataConflictDetail[] = [];
    const proposedItem: Record<string, unknown> = {};

    for (const [field, evidences] of fieldMap.entries()) {
      if (evidences.length === 1) {
        selectedFields[field] = evidences[0];
        proposedItem[field] = evidences[0].normalizedValue;
        rejectedFields[field] = [];
        continue;
      }

      // Sort by effective weight: confidence * provider priority
      const sorted = [...evidences].sort((a, b) => {
        const priorityA = ReconciliationPolicy.getProviderPriority(
          a.sourceProvider,
          field,
        );
        const priorityB = ReconciliationPolicy.getProviderPriority(
          b.sourceProvider,
          field,
        );
        const scoreA = a.confidence * priorityA;
        const scoreB = b.confidence * priorityB;
        return scoreB - scoreA;
      });

      const best = sorted[0];

      // Special handling for array fields: Union tags/keywords and notes across providers
      if (field === 'tags' || field === 'keywords' || field === 'labels') {
        const mergedArray = mergeReconciledTagArrays(
          evidences.map((ev) => ev.normalizedValue),
        );
        selectedFields[field] = {
          ...best,
          normalizedValue: mergedArray,
        };
        proposedItem[field] = mergedArray;
        rejectedFields[field] = [];
        continue;
      }

      if (field === 'notes') {
        const mergedNotes = mergeReconciledNotesArrays(
          evidences.map((ev) => ev.normalizedValue),
          true,
        );
        selectedFields[field] = {
          ...best,
          normalizedValue: mergedNotes,
        };
        proposedItem[field] = mergedNotes;
        rejectedFields[field] = [];
        continue;
      }

      if (field === 'extraFields') {
        const mergedExtra: Record<string, unknown> = {};
        for (const ev of [...sorted].reverse()) {
          if (ev.normalizedValue && typeof ev.normalizedValue === 'object') {
            Object.assign(mergedExtra, ev.normalizedValue);
          }
        }
        selectedFields[field] = {
          ...best,
          normalizedValue: mergedExtra,
        };
        proposedItem[field] = mergedExtra;
        rejectedFields[field] = [];
        continue;
      }

      if (field === 'creators' || field === 'authors') {
        const bestWithContent = selectAuthoritativeCreatorVariant(
          sorted.map((e) => ({
            ev: e,
            sourceProvider: e.sourceProvider,
            val: e.normalizedValue,
          })),
        ).ev;

        selectedFields[field] = bestWithContent;
        proposedItem[field] = bestWithContent.normalizedValue;
        rejectedFields[field] = sorted.filter((e) => e !== bestWithContent);
        continue;
      }

      selectedFields[field] = best;
      proposedItem[field] = best.normalizedValue;
      rejectedFields[field] = sorted.slice(1);

      // Conflict detection for non-array values with differing string representations
      if (typeof best.normalizedValue !== 'object') {
        const divergent = sorted.filter(
          (e) =>
            String(e.normalizedValue).toLowerCase() !==
            String(best.normalizedValue).toLowerCase(),
        );

        if (divergent.length > 0) {
          const highConfidenceDivergent = divergent.filter(
            (e) => e.confidence >= 0.8,
          );
          conflicts.push({
            field,
            description: `Divergent values found for field "${field}" across providers`,
            severity: highConfidenceDivergent.length > 0 ? 'high' : 'medium',
            variants: sorted.map((e) => ({
              sourceProvider: e.sourceProvider,
              value: e.normalizedValue,
              confidenceScore: e.confidence,
            })),
          });
        }
      }
    }

    finalizeReconciledBibliographicMetadata(proposedItem);

    return {
      selectedFields,
      rejectedFields,
      conflicts,
      proposedItem: proposedItem,
      decidedAt: new Date().toISOString(),
      policyVersion: '1.1.0',
    };
  }
}
