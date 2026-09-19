import { Injectable } from '@nestjs/common';
import {
  MetadataCandidate,
  FieldEvidence,
  ReconciliationDecision,
  MetadataConflictDetail,
} from '../types/metadata-candidate.types';
import { ItemMetadata } from '../metadata/types/metadata.types';
import { normalizeAcademicTags } from '../../tags/utils/tags.utils';
import { BASE_FIELD_MAPPINGS } from '../../types/constants/types.constants';

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
    crossref: 90,
    PubMed: 88, // NLM curated; authoritative for biomedical domain
    pubmed: 88,
    ZoteroSync: 85, // User's verified Zotero library data
    zotero: 85,
    EnrichedProvider: 85, // Automated multi-provider enrichment
    MetadataResolution: 80, // Resolved provider cascade
    OpenAlex: 78, // Aggregator; strong for enrichment, weaker for core fields
    openalex: 78,
    arXiv: 65, // ⚠️ Lowered: submission year ≠ publication year; preprint-only fields
    arxiv: 65,
    OpenLibrary: 65, // Book metadata only; community-maintained
    openlibrary: 65,
    BibTeX: 60, // User-imported file; quality depends on export source
    bibtex: 60,
    RIS: 60, // User-imported file; quality depends on export source
    ris: 60,
    UrlCapture: 50, // Web scraping; lowest structural reliability
    unpaywall: 55,
    StagedPdf: 40, // GROBID/LocalPDFExtraction; noisy for venue/year fields
  };

  private static getProviderPriority(provider: string): number {
    if (!provider) return 50;
    const direct = ReconciliationPolicy.PROVIDER_PRIORITY[provider];
    if (direct !== undefined) return direct;
    const lower = provider.toLowerCase();
    for (const [key, val] of Object.entries(
      ReconciliationPolicy.PROVIDER_PRIORITY,
    )) {
      if (key.toLowerCase() === lower) return val;
    }
    return 50;
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
        const priorityA = ReconciliationPolicy.getProviderPriority(
          a.sourceProvider,
        );
        const priorityB = ReconciliationPolicy.getProviderPriority(
          b.sourceProvider,
        );
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

      if (field === 'creators' || field === 'authors') {
        const bestWithContent =
          sorted.find(
            (e) =>
              Array.isArray(e.normalizedValue) && e.normalizedValue.length > 0,
          ) || best;
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

    // Ensure title exists
    if (!proposedItem.title) {
      proposedItem.title = 'Untitled Document';
    }

    // Ensure itemType exists
    if (!proposedItem.itemType) {
      proposedItem.itemType = 'journalArticle';
    }

    // Harmonize venue and publisher per Zotero itemType schema (DRY baseField mappings)
    const baseMap = BASE_FIELD_MAPPINGS[proposedItem.itemType];
    if (baseMap) {
      const venueField = baseMap.publicationTitle;
      if (venueField && venueField !== 'publicationTitle') {
        if (proposedItem.publicationTitle && !proposedItem[venueField]) {
          proposedItem[venueField] = proposedItem.publicationTitle;
        } else if (proposedItem[venueField] && !proposedItem.publicationTitle) {
          proposedItem.publicationTitle = proposedItem[venueField];
        }
      }
      const publisherField = baseMap.publisher;
      if (publisherField && publisherField !== 'publisher') {
        if (proposedItem.publisher && !proposedItem[publisherField]) {
          proposedItem[publisherField] = proposedItem.publisher;
        } else if (proposedItem[publisherField] && !proposedItem.publisher) {
          proposedItem.publisher = proposedItem[publisherField];
        }
      }
    }
    if (proposedItem.itemType === 'journalArticle' || !proposedItem.itemType) {
      if (proposedItem.publicationTitle && !proposedItem.journal) {
        proposedItem.journal = proposedItem.publicationTitle;
      } else if (proposedItem.journal && !proposedItem.publicationTitle) {
        proposedItem.publicationTitle = proposedItem.journal;
      }
    }

    // Harmonize creators and authors
    if (
      Array.isArray(proposedItem.creators) &&
      proposedItem.creators.length > 0
    ) {
      if (!proposedItem.authors || proposedItem.authors.length === 0) {
        const authorCreators = proposedItem.creators.filter(
          (c: any) => c.creatorType === 'author' || !c.creatorType,
        );
        const effectiveList =
          authorCreators.length > 0 ? authorCreators : proposedItem.creators;
        proposedItem.authors = effectiveList
          .map(
            (c: any) =>
              c.fullName ||
              c.name ||
              `${c.firstName || ''} ${c.lastName || ''}`.trim(),
          )
          .filter(Boolean);
      }
    } else if (
      Array.isArray(proposedItem.authors) &&
      proposedItem.authors.length > 0
    ) {
      if (!proposedItem.creators || proposedItem.creators.length === 0) {
        proposedItem.creators = proposedItem.authors.map(
          (authorName: string, idx: number) => ({
            orderIndex: idx,
            creatorType: 'author',
            name: authorName,
            fullName: authorName,
          }),
        );
      }
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
