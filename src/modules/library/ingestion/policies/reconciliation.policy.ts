import { Injectable } from '@nestjs/common';
import {
  MetadataCandidate,
  FieldEvidence,
  ReconciliationDecision,
  MetadataConflictDetail,
} from '../types/metadata-candidate.types';
import { ItemMetadata } from '../metadata/types/metadata.types';
import { normalizeAcademicTags } from '../../tags/utils/tags.utils';

@Injectable()
export class ReconciliationPolicy {
  /**
   * Global provider priority scores for ingestion-pipeline reconciliation.
   *
   * Used in Layer 2 reconciliation (IngestionPolicy) where multiple IngestionCandidates
   * compete: e.g. a BibTeX file upload vs. the EnrichedProvider result.
   *
   * Formula: evidence.confidence × PROVIDER_PRIORITY[provider] → winner takes field.
   *
   * NOTE: For fine-grained per-field authority, see ReconciliationService.FIELD_AUTHORITY_WEIGHTS
   * (Layer 1, used within MetadataService.resolve()).
   *
   * policyVersion: 1.1.0
   */
  private static readonly PROVIDER_PRIORITY: Record<string, number> = {
    UserOverride: 100, // Always wins — never overwrite user intent
    DirectIdentifier: 95, // DOI/PMID/arXivId resolved directly from source
    CrossRef: 90, // Publisher-submitted bibliographic authority
    PubMed: 88, // NLM curated; authoritative for biomedical domain
    ZoteroSync: 85, // User's verified Zotero library data
    OpenAlex: 78, // Aggregator; strong for enrichment, weaker for core fields
    arXiv: 65, // ⚠️ Lowered: submission year ≠ publication year; preprint-only fields
    OpenLibrary: 65, // Book metadata only; community-maintained
    BibTeX: 60, // User-imported file; quality depends on export source
    RIS: 60, // User-imported file; quality depends on export source
    UrlCapture: 50, // Web scraping; lowest structural reliability
    StagedPdf: 40, // GROBID/LocalPDFExtraction; noisy for venue/year fields
  };

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
    const proposedItem: Record<string, any> = {};

    for (const [field, evidences] of fieldMap.entries()) {
      if (evidences.length === 1) {
        selectedFields[field] = evidences[0];
        proposedItem[field] = evidences[0].normalizedValue;
        rejectedFields[field] = [];
        continue;
      }

      // Sort by effective weight: confidence * provider priority
      const sorted = [...evidences].sort((a, b) => {
        const priorityA =
          ReconciliationPolicy.PROVIDER_PRIORITY[a.sourceProvider] || 50;
        const priorityB =
          ReconciliationPolicy.PROVIDER_PRIORITY[b.sourceProvider] || 50;
        const scoreA = a.confidence * priorityA;
        const scoreB = b.confidence * priorityB;
        return scoreB - scoreA;
      });

      const best = sorted[0];

      // Special handling for array fields: Union tags/keywords and notes across providers
      if (field === 'tags' || field === 'keywords' || field === 'labels') {
        const candidateTags: string[] = [];
        for (const ev of evidences) {
          if (Array.isArray(ev.normalizedValue)) {
            for (const t of ev.normalizedValue) {
              if (typeof t === 'string' && t.trim()) {
                candidateTags.push(t.trim());
              }
            }
          }
        }
        const mergedArray = normalizeAcademicTags(candidateTags);
        selectedFields[field] = {
          ...best,
          normalizedValue: mergedArray,
        };
        proposedItem[field] = mergedArray;
        rejectedFields[field] = [];
        continue;
      }

      if (field === 'notes') {
        const mergedNotes: Array<{ content: string; source?: string }> = [];
        const seen = new Set<string>();
        for (const ev of evidences) {
          if (Array.isArray(ev.normalizedValue)) {
            for (const n of ev.normalizedValue) {
              const text =
                typeof n === 'string'
                  ? n.trim()
                  : n && typeof n === 'object'
                    ? String(n.content || '').trim()
                    : '';
              if (text && !seen.has(text)) {
                seen.add(text);
                mergedNotes.push(
                  typeof n === 'string'
                    ? { content: text }
                    : { content: text, source: n.source },
                );
              }
            }
          }
        }
        selectedFields[field] = {
          ...best,
          normalizedValue: mergedNotes,
        };
        proposedItem[field] = mergedNotes;
        rejectedFields[field] = [];
        continue;
      }

      if (field === 'extraFields') {
        const mergedExtra: Record<string, any> = {};
        for (const ev of evidences) {
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

    // Ensure title exists
    if (!proposedItem.title) {
      proposedItem.title = 'Untitled Document';
    }

    // Ensure itemType exists
    if (!proposedItem.itemType) {
      proposedItem.itemType = 'journalArticle';
    }

    return {
      selectedFields,
      rejectedFields,
      conflicts,
      proposedItem: proposedItem as ItemMetadata,
      decidedAt: new Date().toISOString(),
      policyVersion: '1.1.0',
    };
  }
}
