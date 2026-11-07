import { isPlaceholderItemTitle, titleSimilarity, hasAuthorAndYearCorroboration, extractNormalizedAuthorSurnames } from './title.domain';
import { normalizeTags } from './tag.domain';
import {
  mergeExtraTextLines, mergeExtraTextWithStatus, resolveFieldAliases, resolveBidirectionalBaseFields,
  harmonizeBibliographicFields, harmonizeFields, synchronizeVenueBaseFields, buildBibliographicMutationPayload,
  getEffectiveBaseFieldMap, getEffectiveReverseBaseFieldMap,
} from './field-harmonizer.domain';
import { parseCreatorString } from './author.domain';
import { normalizeDoi, normalizeArxivId, normalizePmid, normalizePmcid, normalizeIsbn, normalizeIssn } from './identifier.domain';
import { ItemMetadata } from '../types/bibliographic.types';

export {
  extractNormalizedAuthorSurnames, harmonizeBibliographicFields, harmonizeFields,
  synchronizeVenueBaseFields, buildBibliographicMutationPayload, getEffectiveBaseFieldMap,
  getEffectiveReverseBaseFieldMap, resolveFieldAliases, resolveBidirectionalBaseFields,
  mergeExtraTextLines, mergeExtraTextWithStatus,
};

export enum OriginTier { FILENAME_FALLBACK = 0, LOCAL_EXTRACTED = 1, SUPPLEMENTAL_GRAPH = 2, AUTHORITATIVE_REGISTRY = 3, USER_OVERRIDE = 4 }

const USER_OVERRIDE_PROVIDERS = new Set(['useroverride', 'user', 'manual', 'useridentifier']);
const AUTHORITATIVE_REGISTRY_PROVIDERS = new Set(['crossref', 'pubmed', 'arxiv', 'openlibrary', 'zoteroconnector', 'zotero', 'bibliographyrecord', 'enrichedprovider', 'metadataresolution', 'directidentifier']);
const SUPPLEMENTAL_GRAPH_PROVIDERS = new Set(['openalex', 'semanticscholar', 'dblp', 'europepmc', 'datacite', 'unpaywall', 'bibtex', 'ris', 'csljson', 'csl_json']);
const LOCAL_EXTRACTED_PROVIDERS = new Set(['trustedpaper', 'stagedpdf', 'pdfmetadata', 'localpdfextraction', 'localinprocess', 'local_in_process', 'localpdf', 'local_pdf', 'urlscraper', 'urlcapture', 'file']);

export const TIER_BASE_WEIGHT: Readonly<Record<OriginTier, number>> = {
  [OriginTier.USER_OVERRIDE]: 10.0, [OriginTier.AUTHORITATIVE_REGISTRY]: 1.0,
  [OriginTier.SUPPLEMENTAL_GRAPH]: 0.85, [OriginTier.LOCAL_EXTRACTED]: 0.6, [OriginTier.FILENAME_FALLBACK]: 0.45,
};

/**
 * Unified AuthoritySource weights reconciling MetadataService `PROVIDER_PRIORITY`
 * and MetadataCoalescePolicy `SOURCE_WEIGHTS`.
 */
export const AUTHORITY_SOURCE_WEIGHTS: Readonly<Record<string, number>> = {
  useroverride: 10.0, user: 10.0, manual: 10.0, useridentifier: 10.0,
  crossref: 1.0, pubmed: 1.0, zoteroconnector: 1.0, zotero: 1.0, bibliographyrecord: 1.0,
  enrichedprovider: 1.0, metadataresolution: 1.0, directidentifier: 1.0, arxiv: 1.0, openlibrary: 1.0,
  openalex: 0.85, semanticscholar: 0.85, dblp: 0.85, europepmc: 0.85, datacite: 0.85,
  unpaywall: 0.85, bibtex: 0.85, ris: 0.85, csljson: 0.85,
  trustedpaper: 0.6, stagedpdf: 0.6, pdfmetadata: 0.6, localpdfextraction: 0.6,
  localinprocess: 0.6, localpdf: 0.6, urlscraper: 0.6, urlcapture: 0.6, file: 0.6,
  filenamefallback: 0.45, filename: 0.45,
};

export const AUTHORITY_PROVIDER_PRIORITY: Readonly<Record<string, number>> = {
  useroverride: 1000, user: 1000, manual: 1000, useridentifier: 1000,
  crossref: 95, pubmed: 92, zoteroconnector: 90, zotero: 90, bibliographyrecord: 90,
  enrichedprovider: 90, metadataresolution: 90, directidentifier: 90, arxiv: 88, openlibrary: 86,
  openalex: 85, semanticscholar: 82, dblp: 80, europepmc: 78, datacite: 75,
  bibtex: 74, ris: 74, csljson: 74, unpaywall: 70,
  trustedpaper: 60, stagedpdf: 60, pdfmetadata: 60, localpdfextraction: 60,
  localinprocess: 60, localpdf: 60, urlscraper: 58, urlcapture: 58, file: 55,
  filenamefallback: 45, filename: 45,
};

export function resolveProviderTier(provider: string | undefined, _field?: string): OriginTier {
  if (!provider || !provider.trim()) return OriginTier.FILENAME_FALLBACK;
  const lower = provider.trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (USER_OVERRIDE_PROVIDERS.has(lower)) return OriginTier.USER_OVERRIDE;
  if (AUTHORITATIVE_REGISTRY_PROVIDERS.has(lower)) return OriginTier.AUTHORITATIVE_REGISTRY;
  if (SUPPLEMENTAL_GRAPH_PROVIDERS.has(lower)) return OriginTier.SUPPLEMENTAL_GRAPH;
  if (LOCAL_EXTRACTED_PROVIDERS.has(lower)) return OriginTier.LOCAL_EXTRACTED;
  return OriginTier.FILENAME_FALLBACK;
}

export function getAuthoritySourceWeight(provider: string | undefined, field?: string): number {
  if (!provider || !provider.trim()) return 0.5;
  const lower = provider.trim().toLowerCase().replace(/[\s_-]+/g, ''), fieldLower = (field ?? '').trim().toLowerCase();
  const tier = resolveProviderTier(lower, fieldLower);
  if (tier === OriginTier.USER_OVERRIDE) return TIER_BASE_WEIGHT[OriginTier.USER_OVERRIDE];
  if (fieldLower === 'doi' && lower === 'crossref') return 1.05;
  if ((fieldLower === 'pmid' || fieldLower === 'pmcid') && lower === 'pubmed') return 1.05;
  if ((fieldLower === 'arxivid' || fieldLower === 'archiveid') && lower === 'arxiv') return 1.05;
  if ((fieldLower === 'tags' || fieldLower === 'keywords' || fieldLower === 'labels') && lower === 'crossref') return 0.35;
  return AUTHORITY_SOURCE_WEIGHTS[lower] ?? TIER_BASE_WEIGHT[tier];
}

export const resolveProviderFieldWeight = getAuthoritySourceWeight;

export function getAuthorityProviderPriority(provider: string | undefined, field?: string): number {
  if (!provider || !provider.trim()) return 50;
  const lower = provider.trim().toLowerCase().replace(/[\s_-]+/g, ''), fieldLower = (field ?? '').trim().toLowerCase();
  if (USER_OVERRIDE_PROVIDERS.has(lower)) return 1000;
  if ((fieldLower === 'tags' || fieldLower === 'keywords' || fieldLower === 'labels') && lower === 'crossref') return 35;
  return AUTHORITY_PROVIDER_PRIORITY[lower] ?? Math.round(getAuthoritySourceWeight(provider, field) * 100);
}

export function isPaperLevelKeywordSource(provider: string | undefined): boolean {
  return getAuthoritySourceWeight(provider, 'keywords') >= TIER_BASE_WEIGHT[OriginTier.LOCAL_EXTRACTED];
}

export const PREPRINT_SERVER_VENUE_REGEX = /^(?:arxiv(?:\.org)?|corr|biorxiv|medrxiv|chemrxiv|techrxiv|ssrn|research\s+square|osf\s+preprints|hal|zenodo)(?:\s*\([^)]+\))?(?:\s+preprints?|\s+e-?prints?)?$/i;
export const PREPRINT_DOI_PREFIX_REGEX = /^10\.(?:48550\/arxiv\.|1101\/|21203\/|26434\/|20944\/)/i;
export const PUBLISHED_UPGRADE_FIELDS = [
  'doi', 'publicationTitle', 'journal', 'proceedingsTitle', 'conferenceName', 'venue',
  'volume', 'issue', 'pages', 'publisher', 'publicationDate', 'date', 'year', 'issn', 'isbn', 'journalAbbreviation',
] as const;

export function isPreprintVenue(venue: unknown): boolean {
  return typeof venue === 'string' && venue.trim().length > 0 && PREPRINT_SERVER_VENUE_REGEX.test(venue.trim());
}

export function isPreprintDoi(doi: unknown): boolean {
  return typeof doi === 'string' && doi.trim().length > 0 && PREPRINT_DOI_PREFIX_REGEX.test(doi.trim());
}

/**
 * Upgrades a preprint bibliographic record (`arXiv`, `bioRxiv`, `medRxiv`, etc.) to its
 * peer-reviewed published counterpart (`journalArticle` or `conferencePaper`) when a
 * non-preprint DOI and/or peer-reviewed venue is available, while preserving `arxivId`
 * and `arXiv: <id>` in `extra`.
 */
export function upgradePreprintToPublished(
  existingRecord: Record<string, unknown>,
  incomingRecord?: Record<string, unknown>,
  options?: { preserveArxivInExtra?: boolean },
): { upgraded: boolean; targetItemType: string; record: Record<string, unknown>; upgradedFields: string[] } {
  const merged: Record<string, unknown> = { ...existingRecord };
  const upgradedFields: string[] = [];
  const extractArxiv = (rec?: Record<string, unknown>): string => {
    if (!rec) return '';
    const raw = rec.arxivId || (/^arxiv:/i.test(String(rec.archiveId || '')) ? rec.archiveId : '') ||
      (typeof rec.doi === 'string' && /^10\.48550\/arxiv\./i.test(rec.doi) ? rec.doi.replace(/^10\.48550\/arxiv\./i, '') : '');
    return normalizeArxivId(String(raw || ''), { stripVersion: true }) || '';
  };
  const preservedArxivId = extractArxiv(existingRecord) || extractArxiv(incomingRecord);
  const existingVenue = String(existingRecord.publicationTitle || existingRecord.journal || existingRecord.proceedingsTitle || existingRecord.venue || existingRecord.repository || '').trim();
  const existingDoi = typeof existingRecord.doi === 'string' ? existingRecord.doi.trim() : '';
  const existingType = String(existingRecord.itemType || existingRecord.type || 'journalArticle');
  const existingIsPreprint = existingType === 'preprint' || isPreprintVenue(existingVenue) || isPreprintDoi(existingDoi) || Boolean(preservedArxivId && (!existingDoi || isPreprintDoi(existingDoi)));

  if (incomingRecord) {
    const incomingVenue = String(incomingRecord.publicationTitle || incomingRecord.journal || incomingRecord.proceedingsTitle || incomingRecord.venue || '').trim();
    const incomingDoi = typeof incomingRecord.doi === 'string' ? incomingRecord.doi.trim() : '';
    const incomingIsPublished = (Boolean(incomingDoi) && !isPreprintDoi(incomingDoi)) || (Boolean(incomingVenue) && !isPreprintVenue(incomingVenue));
    if (existingIsPreprint && incomingIsPublished) {
      for (const field of PUBLISHED_UPGRADE_FIELDS) {
        const incVal = incomingRecord[field];
        if (incVal !== undefined && incVal !== null && incVal !== '' &&
          !(field === 'doi' && isPreprintDoi(incVal)) &&
          !((field === 'publicationTitle' || field === 'journal' || field === 'venue' || field === 'publisher') && isPreprintVenue(incVal))) {
          if (merged[field] !== incVal) {
            merged[field] = incVal;
            upgradedFields.push(field);
          }
        }
      }
      if (incomingRecord.itemType && incomingRecord.itemType !== 'preprint') merged.itemType = incomingRecord.itemType;
    }
  }

  const resolvedDoi = typeof merged.doi === 'string' ? merged.doi.trim() : '';
  const isPublishedDoi = Boolean(resolvedDoi && !isPreprintDoi(resolvedDoi));
  const resolvedVenue = String(merged.proceedingsTitle || merged.publicationTitle || merged.journal || merged.venue || '').trim();
  const hasPublishedVenue = Boolean(resolvedVenue && !isPreprintVenue(resolvedVenue));
  let upgraded = upgradedFields.length > 0;
  let targetItemType = String(merged.itemType || existingType || 'journalArticle');

  if (existingIsPreprint && (isPublishedDoi || hasPublishedVenue)) {
    const hasConferenceSignal = Boolean(
      (typeof merged.proceedingsTitle === 'string' && merged.proceedingsTitle.trim() && !isPreprintVenue(merged.proceedingsTitle)) ||
      (typeof merged.conferenceName === 'string' && merged.conferenceName.trim()),
    );
    targetItemType = hasConferenceSignal ? 'conferencePaper' : 'journalArticle';
    if (merged.itemType !== targetItemType) {
      merged.itemType = targetItemType;
      upgraded = true;
    }
    synchronizeVenueBaseFields(merged, targetItemType, {
      primaryVenue: hasPublishedVenue ? resolvedVenue : undefined,
      pruneForeignContainerKeys: true,
    });
  }

  if (preservedArxivId) {
    merged.arxivId = preservedArxivId;
    if (options?.preserveArxivInExtra !== false && (targetItemType === 'journalArticle' || targetItemType === 'conferencePaper') && (isPublishedDoi || hasPublishedVenue)) {
      merged.extra = mergeExtraTextLines([merged.extra, `arXiv: ${preservedArxivId}`]);
    }
  }

  return { upgraded, targetItemType, record: merged, upgradedFields };
}

const AUTHORITATIVE_CREATOR_PROVIDERS = new Set(['crossref', 'pubmed', 'arxiv', 'enrichedprovider', 'openalex', 'semanticscholar', 'dblp', 'zotero', 'bibtex', 'ris']);
const ABSTRACT_BOILERPLATE_REGEX = /^(?:n\/?a|none|null|undefined|abstract\s+not\s+available\.?|no\s+abstract\s+available\.?|abstract\s+unavailable\.?|not\s+available\.?|-+|\.+)$/i;

export const ALIAS_EVIDENCE_FALLBACK_KEYS: Readonly<Record<string, readonly string[]>> = {
  publicationTitle: ['publicationTitle', 'journal', 'venue', 'proceedingsTitle', 'conferenceName', 'bookTitle', 'websiteTitle', 'reporter', 'code'],
  journal: ['journal', 'publicationTitle', 'venue'], abstract: ['abstract', 'abstractNote'], abstractNote: ['abstractNote', 'abstract'],
  authors: ['authors', 'creators'], creators: ['creators', 'authors'], arxivId: ['arxivId', 'archiveId', 'archiveID'], archiveId: ['archiveId', 'arxivId', 'archiveID'],
  journalAbbreviation: ['journalAbbreviation', 'journalAbbr'], journalAbbr: ['journalAbbr', 'journalAbbreviation'],
  publicationDate: ['publicationDate', 'date', 'dateDecided', 'dateEnacted', 'issueDate', 'filingDate'], date: ['date', 'publicationDate', 'dateDecided', 'dateEnacted', 'issueDate', 'filingDate'],
  publisher: ['publisher', 'university', 'institution', 'repository', 'issuingAuthority', 'court'], place: ['place', 'eventPlace', 'country'], eventPlace: ['eventPlace', 'place'],
  issue: ['issue', 'number', 'reportNumber', 'docketNumber', 'publicLawNumber', 'patentNumber'], number: ['number', 'issue', 'reportNumber', 'docketNumber', 'publicLawNumber', 'patentNumber'],
  numPages: ['numPages', 'numberOfPages'], numberOfPages: ['numberOfPages', 'numPages'], authority: ['authority', 'issuingAuthority', 'court'], issuingAuthority: ['issuingAuthority', 'authority'],
  doi: ['doi', 'DOI'], isbn: ['isbn', 'ISBN'], issn: ['issn', 'ISSN'], pmid: ['pmid', 'PMID'], pmcid: ['pmcid', 'PMCID'], url: ['url', 'URL'], rights: ['rights', 'license'], license: ['license', 'rights'],
};

function hasFullGivenNameToken(rawGiven: string): boolean {
  for (const token of rawGiven.trim().split(/[\s-]+/).map((t) => t.trim()).filter(Boolean)) {
    if (token.endsWith('.')) continue;
    const cleaned = token.replace(/[^a-zA-Z\u00C0-\u024F\u1E00-\u1EFF]/g, '');
    if ((cleaned.length >= 2 && !/^[A-Z]+$/.test(cleaned)) || cleaned.length > 2) return true;
  }
  return false;
}

export function countFullGivenNames(creatorsOrAuthors: unknown[]): number {
  if (!Array.isArray(creatorsOrAuthors)) return 0;
  let count = 0;
  for (const entry of creatorsOrAuthors) {
    if (typeof entry === 'string') {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      if (trimmed.includes(',')) {
        if (hasFullGivenNameToken(trimmed.split(',').slice(1).join(' '))) count++;
      } else {
        const parts = trimmed.split(/\s+/).filter(Boolean);
        if (parts.length >= 2 && hasFullGivenNameToken(parts.slice(0, -1).join(' '))) count++;
      }
    } else if (entry && typeof entry === 'object') {
      const obj = entry as { firstName?: string; given?: string; givenName?: string; fullName?: string; name?: string; fieldMode?: number };
      if (obj.fieldMode === 1) continue;
      const explicitGiven = obj.firstName ?? obj.given ?? obj.givenName;
      if (typeof explicitGiven === 'string' && explicitGiven.trim()) {
        if (hasFullGivenNameToken(explicitGiven)) count++;
        continue;
      }
      const fullStr = obj.fullName ?? obj.name;
      if (typeof fullStr === 'string' && fullStr.trim() && countFullGivenNames([fullStr]) > 0) count++;
    }
  }
  return count;
}

export function isBetterAuthorListCandidate(candAuth: number, candLen: number, candFullGiven: number, bestAuth: number, bestLen: number, bestFullGiven: number): boolean {
  if (candLen === 0) return false;
  if (candAuth > bestAuth + (bestAuth > 1 ? 15 : 0.14)) return true;
  if (candAuth < bestAuth || candLen < bestLen) return false;
  return candLen > bestLen || candFullGiven > bestFullGiven;
}

export function selectAuthoritativeCreatorVariant<T extends { sourceProvider?: string; val: unknown; isUserOverride?: boolean }>(sortedVariants: T[]): T {
  const firstNonEmpty = sortedVariants.find((v) => Array.isArray(v.val) && v.val.length > 0) || sortedVariants[0];
  const firstProv = (firstNonEmpty?.sourceProvider || '').toLowerCase();
  if (firstNonEmpty?.isUserOverride || firstProv === 'useroverride' || firstProv === 'user' || firstProv === 'manual') return firstNonEmpty;
  let best = firstNonEmpty;
  for (const cand of sortedVariants) {
    if (!AUTHORITATIVE_CREATOR_PROVIDERS.has((cand.sourceProvider || '').toLowerCase()) || !Array.isArray(cand.val) || cand.val.length === 0) continue;
    const bestArr = Array.isArray(best?.val) ? best.val : [];
    if (isBetterAuthorListCandidate(1, cand.val.length, countFullGivenNames(cand.val), 1, bestArr.length, countFullGivenNames(bestArr))) best = cand;
  }
  return best;
}

export function mergeReconciledTagArrays(arrays: unknown[]): string[] {
  const candidateTags: string[] = [];
  for (const arr of arrays) if (Array.isArray(arr)) for (const t of arr) if (typeof t === 'string' && t.trim()) candidateTags.push(t.trim());
  return normalizeTags(candidateTags);
}

export function mergeReconciledNotesArrays(arrays: unknown[], normalizeToObject = false): unknown[] {
  const seen = new Set<string>(), merged: unknown[] = [];
  for (const arr of arrays) {
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      const noteObj = item && typeof item === 'object' ? (item as Record<string, unknown>) : null;
      const rawNoteContent = noteObj?.content ?? noteObj?.contentMd ?? noteObj?.note;
      const text = typeof item === 'string' ? item.trim() : typeof rawNoteContent === 'string' ? rawNoteContent.trim() : '';
      const dedupeKey = text ? text.toLowerCase() : normalizeToObject ? '' : JSON.stringify(item);
      if (dedupeKey && !seen.has(dedupeKey)) {
        seen.add(dedupeKey);
        merged.push(
          normalizeToObject
            ? typeof item === 'string' ? { content: text } : {
                content: text,
                ...(typeof noteObj?.title === 'string' && noteObj.title.trim() ? { title: noteObj.title.trim() } : {}),
                ...(typeof noteObj?.source === 'string' && noteObj.source.trim() ? { source: noteObj.source.trim() } : {}),
                ...(Array.isArray(noteObj?.tags) && noteObj.tags.length > 0 ? { tags: noteObj.tags as string[] } : {}),
              }
            : item,
        );
      }
    }
  }
  return merged;
}

export function mergeReconciledExtraText(variants: unknown[]): string {
  return mergeExtraTextLines(variants);
}

export function finalizeReconciledBibliographicMetadata(resolved: Record<string, unknown>, _candidates?: Array<{ sourceProvider?: string; metadata?: Record<string, unknown> }>): void {
  if (!resolved.title) resolved.title = 'Untitled Document';
  if (!resolved.itemType || typeof resolved.itemType !== 'string') resolved.itemType = 'journalArticle';
  let itemType = String(resolved.itemType);
  const resolvedYearNum = typeof resolved.year === 'number' ? resolved.year : typeof resolved.year === 'string' && /^\d{4}$/.test(resolved.year.trim()) ? Number(resolved.year.trim()) : undefined;
  if (resolvedYearNum && resolvedYearNum >= 1000 && resolvedYearNum <= 2999) {
    const yearStr = String(resolvedYearNum);
    for (const dateKey of ['publicationDate', 'date'] as const) {
      const rawDate = resolved[dateKey];
      if (typeof rawDate === 'string' && rawDate.trim() && rawDate.match(/\b(19\d{2}|20\d{2})\b/)?.[1] && rawDate.match(/\b(19\d{2}|20\d{2})\b/)?.[1] !== yearStr) {
        const matchingCandDate = _candidates
          ?.map((c) => {
            const candVal = ((c.metadata ?? c) as Record<string, unknown>)?.[dateKey];
            if (typeof candVal === 'string') return candVal;
            return candVal && typeof candVal === 'object' && typeof (candVal as { normalizedValue?: unknown }).normalizedValue === 'string' ? (candVal as { normalizedValue: string }).normalizedValue : undefined;
          })
          .find((d) => typeof d === 'string' && d.match(/\b(19\d{2}|20\d{2})\b/)?.[1] === yearStr);
        resolved[dateKey] = matchingCandDate ?? yearStr;
      }
    }
  }
  resolveBidirectionalBaseFields(resolved, itemType, undefined, false);
  const rawArxivCandidate = normalizeArxivId(
    String(resolved.arxivId || (/^arxiv:/i.test(String(resolved.archiveId || '')) ? resolved.archiveId : '') || (typeof resolved.doi === 'string' && /^10\.48550\/arxiv\./i.test(resolved.doi) ? resolved.doi.replace(/^10\.48550\/arxiv\./i, '') : '')),
    { stripVersion: true },
  ) || '';
  const isValidArxivId = /^\d{4}\.\d{4,5}$/.test(rawArxivCandidate) || /^[a-z-]+(?:\.[a-z]{2})?\/\d{7}$/i.test(rawArxivCandidate);
  const isNonArxivDoi = Boolean(typeof resolved.doi === 'string' && resolved.doi.trim() && !isPreprintDoi(resolved.doi.trim()));
  const rawVenue = String(resolved.publicationTitle || resolved.journal || resolved.proceedingsTitle || '').trim();
  if (itemType === 'preprint' && isNonArxivDoi && rawVenue && !isPreprintVenue(rawVenue)) {
    const targetPublishedType = resolved.proceedingsTitle || resolved.conferenceName ? 'conferencePaper' : 'journalArticle';
    itemType = targetPublishedType;
    resolved.itemType = targetPublishedType;
  } else if (
    (itemType === 'journalArticle' || itemType === 'report' || itemType === 'document') &&
    isValidArxivId && !isNonArxivDoi && (!rawVenue || isPreprintVenue(rawVenue))
  ) {
    itemType = 'preprint';
    resolved.itemType = 'preprint';
  }
  if ((itemType === 'journalArticle' || itemType === 'conferencePaper') && isNonArxivDoi && isValidArxivId) {
    resolved.arxivId = rawArxivCandidate;
    resolved.extra = mergeReconciledExtraText([resolved.extra, `arXiv: ${rawArxivCandidate}`]);
  }
  const deleteForeignKeys = (keys: readonly string[]) => {
    for (const k of keys) {
      delete resolved[k];
      if (resolved.extraFields && typeof resolved.extraFields === 'object') {
        delete (resolved.extraFields as Record<string, unknown>)[k];
      }
    }
  };
  if (itemType === 'journalArticle') {
    if (resolved.publicationTitle && !resolved.journal) resolved.journal = resolved.publicationTitle;
    else if (resolved.journal && !resolved.publicationTitle) resolved.publicationTitle = resolved.journal;
    if (typeof resolved.publisher === 'string' && isPreprintVenue(resolved.publisher.trim())) delete resolved.publisher;
    deleteForeignKeys(['proceedingsTitle', 'conferenceName', 'bookTitle', 'university', 'thesisType', 'reportNumber', 'reportType', 'repository', 'archiveLocation']);
  } else if (itemType === 'conferencePaper') {
    if (!resolved.proceedingsTitle && (resolved.publicationTitle || resolved.journal)) resolved.proceedingsTitle = resolved.publicationTitle || resolved.journal;
    if (resolved.proceedingsTitle && !resolved.publicationTitle) resolved.publicationTitle = resolved.proceedingsTitle;
    if (typeof resolved.publisher === 'string' && isPreprintVenue(resolved.publisher.trim())) delete resolved.publisher;
    deleteForeignKeys(['journal', 'bookTitle', 'university', 'thesisType', 'reportNumber', 'reportType', 'repository', 'archiveLocation']);
  } else if (itemType === 'bookSection') {
    if (!resolved.bookTitle && (resolved.publicationTitle || resolved.journal)) resolved.bookTitle = resolved.publicationTitle || resolved.journal;
    if (resolved.bookTitle && !resolved.publicationTitle) resolved.publicationTitle = resolved.bookTitle;
    deleteForeignKeys(['journal', 'proceedingsTitle', 'conferenceName', 'university', 'thesisType', 'reportNumber', 'reportType']);
  } else if (itemType === 'book') {
    deleteForeignKeys(['journal', 'proceedingsTitle', 'conferenceName', 'bookTitle', 'university', 'thesisType', 'reportNumber', 'reportType']);
  } else if (itemType === 'preprint') {
    if (rawVenue && !isPreprintVenue(rawVenue)) {
      const extraObj = resolved.extraFields && typeof resolved.extraFields === 'object' ? (resolved.extraFields as Record<string, unknown>) : {};
      if (!extraObj.journalRef) resolved.extraFields = { ...extraObj, journalRef: rawVenue };
    }
    if (isValidArxivId && !isNonArxivDoi) {
      resolved.repository = resolved.repository || 'arXiv';
      resolved.archive = resolved.archive || 'arXiv';
      resolved.arxivId = rawArxivCandidate;
      resolved.archiveId = `arXiv:${rawArxivCandidate}`;
      resolved.doi = `10.48550/arXiv.${rawArxivCandidate}`;
    } else {
      resolved.repository = resolved.repository || resolved.institution || resolved.publicationTitle || resolved.journal || resolved.publisher;
    }
    deleteForeignKeys(['publicationTitle', 'journal', 'proceedingsTitle', 'conferenceName', 'bookTitle', 'series', 'volume', 'issue', 'pages', 'journalAbbr', 'journalAbbreviation', 'issn', 'isbn']);
  }
  if (Array.isArray(resolved.creators) && resolved.creators.length > 0) {
    const creatorsList = resolved.creators as Array<{ creatorType?: string; fullName?: string; name?: string; firstName?: string; lastName?: string; orderIndex?: number }>;
    const authorsList = resolved.authors as unknown[] | undefined;
    const authorCreators = creatorsList.filter((c) => c.creatorType === 'author' || !c.creatorType);
    const nonAuthorCreators = creatorsList.filter((c) => Boolean(c.creatorType && c.creatorType !== 'author'));
    const effectiveList = authorCreators.length > 0 ? authorCreators : creatorsList;
    if (!authorsList || authorsList.length === 0 || effectiveList.length > authorsList.length || (effectiveList.length === authorsList.length && countFullGivenNames(effectiveList) >= countFullGivenNames(authorsList))) {
      resolved.authors = effectiveList.map((c) => c.fullName || c.name || `${c.firstName || ''} ${c.lastName || ''}`.trim()).filter(Boolean);
    } else if (Array.isArray(authorsList) && (authorsList.length > effectiveList.length || countFullGivenNames(authorsList) > countFullGivenNames(effectiveList))) {
      const upgradedAuthors = (authorsList as string[]).map((a, idx) => parseCreatorString(String(a), idx, 'author')).filter((c): c is NonNullable<typeof c> => c !== null);
      resolved.creators = [...upgradedAuthors, ...nonAuthorCreators.map((c, idx) => ({ ...c, orderIndex: upgradedAuthors.length + idx }))];
    }
  } else if (Array.isArray(resolved.authors) && resolved.authors.length > 0 && (!Array.isArray(resolved.creators) || resolved.creators.length === 0)) {
    resolved.creators = (resolved.authors as string[]).map((a, idx) => parseCreatorString(a, idx, 'author')).filter((c): c is NonNullable<typeof c> => c !== null);
  }
  const currentCreators = Array.isArray(resolved.creators) ? (resolved.creators as Array<{ creatorType?: string; fullName?: string; name?: string; firstName?: string; lastName?: string; orderIndex?: number }>) : [];
  const editorCreators = currentCreators.filter((c) => c.creatorType === 'editor');
  const editorsList = Array.isArray(resolved.editors) ? (resolved.editors as string[]).map((e) => String(e).trim()).filter(Boolean) : [];
  if (editorsList.length > 0 && editorCreators.length === 0) {
    const parsedEditors = editorsList.map((e, idx) => parseCreatorString(e, currentCreators.length + idx, 'editor')).filter((c): c is NonNullable<typeof c> => c !== null);
    resolved.creators = [...currentCreators, ...parsedEditors];
  } else if (editorCreators.length > 0 && editorsList.length === 0) {
    resolved.editors = editorCreators.map((c) => c.fullName || c.name || `${c.firstName || ''} ${c.lastName || ''}`.trim()).filter(Boolean);
  }
}

function normalizeComparableIdentifier(rawValue: unknown): string {
  const raw = String(rawValue ?? '').trim();
  if (!raw) return '';
  const norm = normalizeDoi(raw) || normalizeArxivId(raw, { stripVersion: true }) || normalizeIsbn(raw) || normalizePmid(raw) || normalizePmcid(raw) || normalizeIssn(raw) || raw;
  return norm.toLowerCase().replace(/^10\.48550\/arxiv\./i, '').replace(/v\d+$/i, '');
}

export function isSameCanonicalIdentifier(idA: unknown, idB: unknown): boolean {
  const normA = normalizeComparableIdentifier(idA), normB = normalizeComparableIdentifier(idB);
  return Boolean(normA && normB && normA === normB);
}

export function isRejectedCitedIdentifier(rawValue: unknown, rejectedCitedId: unknown): boolean {
  return isSameCanonicalIdentifier(rawValue, rejectedCitedId);
}

export function evaluateCitationTrap(localMeta: Record<string, unknown>, resolvedMeta: Record<string, unknown>, isFilenameFallback?: boolean): { isTrap: boolean; similarity: number; rejectedDoi?: string; rejectedIdentifier?: string } {
  const localExtra = localMeta.extraFields && typeof localMeta.extraFields === 'object' ? (localMeta.extraFields as Record<string, unknown>) : {};
  const effectiveFilenameFallback = isFilenameFallback ?? Boolean(localExtra.isFilenameTitle || localMeta.isFilenameTitle);
  const pdfTitle = typeof localMeta.title === 'string' ? localMeta.title.trim() : '';
  const isCrediblePdfTitle = !effectiveFilenameFallback && pdfTitle.length >= 10 && !isPlaceholderItemTitle(pdfTitle) && !/^manuscript$/i.test(pdfTitle) && !/^\d{4}\s*\d{4,5}(v\d+)?$/i.test(pdfTitle) && !/^arxiv/i.test(pdfTitle);
  const resolvedTitle = typeof resolvedMeta.title === 'string' ? resolvedMeta.title.trim() : '';
  if (!isCrediblePdfTitle || !resolvedTitle) return { isTrap: false, similarity: 1 };
  const similarity = titleSimilarity(resolvedTitle, pdfTitle);
  if (similarity < 0.4 && !hasAuthorAndYearCorroboration(localMeta, resolvedMeta)) {
    const pickId = (meta: Record<string, unknown>, key: string) => (typeof meta[key] === 'string' && meta[key].trim() ? meta[key].trim() : undefined);
    const rejectedDoi = pickId(resolvedMeta, 'doi') || pickId(localMeta, 'doi');
    const rejectedIdentifier = rejectedDoi || pickId(resolvedMeta, 'arxivId') || pickId(localMeta, 'arxivId') || pickId(resolvedMeta, 'pmid') || pickId(localMeta, 'pmid') || pickId(resolvedMeta, 'isbn') || pickId(localMeta, 'isbn');
    return { isTrap: true, similarity, rejectedDoi: rejectedDoi || rejectedIdentifier, rejectedIdentifier };
  }
  return { isTrap: false, similarity };
}

export function verifyTitleLookupCorroboration(query: string, localMeta: Record<string, unknown>, resolvedMeta: Record<string, unknown>): { accepted: boolean; reason?: string; similarity: number } {
  const resolvedTitle = typeof resolvedMeta.title === 'string' ? resolvedMeta.title : '';
  const sim = query.trim() && resolvedTitle.trim() ? titleSimilarity(query, resolvedTitle) : 1;
  if (query.trim() && resolvedTitle.trim() && sim < 0.75) {
    return { accepted: false, reason: `Resolved candidate "${resolvedTitle}" rejected due to low title similarity (${(sim * 100).toFixed(0)}%) with query "${query}".`, similarity: sim };
  }
  const localSurnames = extractNormalizedAuthorSurnames(localMeta), resolvedSurnames = extractNormalizedAuthorSurnames(resolvedMeta);
  const localExtra = localMeta.extraFields && typeof localMeta.extraFields === 'object' ? (localMeta.extraFields as Record<string, unknown>) : {};
  const localNested = localMeta.metadata && typeof localMeta.metadata === 'object' ? (localMeta.metadata as Record<string, unknown>) : {};
  const existingYear = Number(localMeta.year || localExtra.year || localNested.year || 0), resolvedYear = Number(resolvedMeta.year || 0);
  const hasCompatibleYear = existingYear > 0 && resolvedYear > 0 && Math.abs(existingYear - resolvedYear) <= 1;
  if (localSurnames.size > 0 && resolvedSurnames.size > 0) {
    if (![...localSurnames].some((s) => resolvedSurnames.has(s)) && !(sim >= 0.92 && hasCompatibleYear)) {
      return { accepted: false, reason: `Resolved candidate for title "${query}" rejected due to author mismatch with existing item.`, similarity: sim };
    }
  } else if (localSurnames.size === 0 && existingYear > 0 && resolvedYear > 0 && !hasCompatibleYear) {
    return { accepted: false, reason: `Resolved candidate for title "${query}" rejected due to publication year mismatch (${existingYear} vs ${resolvedYear}).`, similarity: sim };
  }
  return { accepted: true, similarity: sim };
}

export interface CoalesceFieldEvidence {
  path?: string; value?: unknown; rawValue?: unknown; normalizedValue: unknown;
  confidence: number; sourceProvider: string; retrievedAt?: string; warnings?: string[];
  isUserOverride?: boolean; readonly __isAlreadyWeighted?: boolean;
}
export interface CoalesceMetadataCandidate {
  candidateId?: string; sourceKind: 'IDENTIFIER' | 'RECORD' | 'URL' | 'FILE' | 'PROVIDER' | 'CONNECTOR';
  sourceName?: string; sourceProvider?: string; sourceRecordId?: string;
  retrievedAt?: string; schemaVersion?: string; rawEvidenceRef?: string;
  rawMetadata?: Record<string, unknown>; fields: Record<string, CoalesceFieldEvidence>;
  normalizedMetadata: ItemMetadata; confidenceScore?: number; overallConfidence?: number;
}
export interface CoalesceConflictDetail {
  field: string; description: string; severity: 'low' | 'medium' | 'high';
  variants: { sourceProvider: string; value: unknown; confidenceScore: number }[];
}
export interface CoalesceDecision {
  selectedFields: Record<string, CoalesceFieldEvidence>; rejectedFields: Record<string, CoalesceFieldEvidence[]>;
  conflicts: CoalesceConflictDetail[]; proposedItem: ItemMetadata; decidedAt: string; policyVersion: string;
}

export function verifyCandidateMatch(recordCand: CoalesceMetadataCandidate, providerCand: CoalesceMetadataCandidate): boolean {
  if (providerCand.rawEvidenceRef && recordCand.candidateId && providerCand.rawEvidenceRef === recordCand.candidateId) return true;
  const rMeta = recordCand.normalizedMetadata || {}, pMeta = providerCand.normalizedMetadata || {};
  for (const idKey of ['doi', 'arxivId', 'pmid', 'isbn'] as const) {
    const rVal = rMeta[idKey]?.trim(), pVal = pMeta[idKey]?.trim();
    if (rVal && pVal && !isSameCanonicalIdentifier(rVal, pVal)) return false;
  }
  const rYear = Number(rMeta.year), pYear = Number(pMeta.year);
  if (Number.isFinite(rYear) && rYear > 0 && Number.isFinite(pYear) && pYear > 0 && Math.abs(rYear - pYear) > 1) return false;
  const rAuthors = extractNormalizedAuthorSurnames(rMeta.authors?.length ? rMeta.authors : rMeta.creators);
  const pAuthors = extractNormalizedAuthorSurnames(pMeta.authors?.length ? pMeta.authors : pMeta.creators);
  if (rAuthors.size > 0 && pAuthors.size > 0 && ![...rAuthors].some((name) => pAuthors.has(name))) return false;
  if (providerCand.rawEvidenceRef && recordCand.candidateId && providerCand.rawEvidenceRef !== recordCand.candidateId) {
    for (const idKey of ['doi', 'arxivId', 'pmid', 'isbn'] as const) {
      const rVal = rMeta[idKey]?.trim(), pVal = pMeta[idKey]?.trim();
      if ((rVal || pVal) && !isSameCanonicalIdentifier(rVal, pVal)) return false;
    }
    if ((rAuthors.size === 0) !== (pAuthors.size === 0)) return false;
  }
  return true;
}

function isUserSourceProvider(provider?: string, isUserOverride?: boolean): boolean {
  return Boolean(isUserOverride || resolveProviderTier(provider) === OriginTier.USER_OVERRIDE);
}

function computeProviderPriorityScore(provider: string, field?: string, isAlreadyWeighted?: boolean, isUserOverride?: boolean): number {
  if (isUserSourceProvider(provider, isUserOverride)) return 1000;
  if (isAlreadyWeighted && (!provider || provider === 'EnrichedProvider' || provider === 'MetadataResolution')) return 100;
  return getAuthoritySourceWeight(provider, field ?? '') * 100;
}

/**
 * Coalesces multiple field evidences for a single bibliographic field using authority weights,
 * user-override locks, creator given-name completeness, and abstract boilerplate filtering.
 */
export function coalesceMetadataValues(field: string, evidences: CoalesceFieldEvidence[]): {
  winningEvidence: CoalesceFieldEvidence | undefined;
  resolvedValue: unknown;
  rejectedEvidences: CoalesceFieldEvidence[];
  conflict?: CoalesceConflictDetail;
} {
  if (!evidences || evidences.length === 0) {
    return { winningEvidence: undefined, resolvedValue: undefined, rejectedEvidences: [] };
  }
  const stripAnnotation = (ev: CoalesceFieldEvidence): CoalesceFieldEvidence => {
    if (!('__isAlreadyWeighted' in ev)) return ev;
    const { __isAlreadyWeighted: _, ...clean } = ev;
    return clean;
  };
  const sorted = [...evidences].sort((a, b) => {
    const scoreA = a.confidence * computeProviderPriorityScore(a.sourceProvider, field, a.__isAlreadyWeighted, a.isUserOverride);
    const scoreB = b.confidence * computeProviderPriorityScore(b.sourceProvider, field, b.__isAlreadyWeighted, b.isUserOverride);
    if (scoreB !== scoreA) return scoreB - scoreA;
    const weightDiff = getAuthoritySourceWeight(b.sourceProvider, field) - getAuthoritySourceWeight(a.sourceProvider, field);
    return weightDiff !== 0 ? weightDiff : getAuthorityProviderPriority(b.sourceProvider, field) - getAuthorityProviderPriority(a.sourceProvider, field);
  });
  const best = sorted[0], isBestUser = isUserSourceProvider(best.sourceProvider, best.isUserOverride);
  if (field === 'extra' || field === 'extraFields') {
    const resolvedVal = field === 'extra' && sorted.some((ev) => typeof ev.normalizedValue === 'string')
      ? mergeReconciledExtraText(sorted.map((ev) => ev.normalizedValue))
      : sorted.slice().reverse().reduce<Record<string, unknown>>((acc, ev) => ({ ...acc, ...(ev.normalizedValue && typeof ev.normalizedValue === 'object' ? (ev.normalizedValue as Record<string, unknown>) : {}) }), {});
    return { winningEvidence: { ...stripAnnotation(best), normalizedValue: resolvedVal }, resolvedValue: resolvedVal, rejectedEvidences: [] };
  }
  if (field === 'tags' || field === 'labels' || field === 'keywords' || field === 'notes') {
    let pool = isBestUser ? [best] : sorted;
    if (field !== 'notes' && !isBestUser && pool.length > 1) {
      const paperLevelPool = pool.filter((ev) => isPaperLevelKeywordSource(ev.sourceProvider));
      if (paperLevelPool.length > 0) pool = paperLevelPool;
    }
    const resolvedVal = field === 'notes' ? mergeReconciledNotesArrays(pool.map((ev) => ev.normalizedValue), true) : mergeReconciledTagArrays(pool.map((ev) => ev.normalizedValue));
    const winnerEv = pool[0] || best;
    return {
      winningEvidence: { ...stripAnnotation(winnerEv), normalizedValue: resolvedVal, ...(isBestUser ? { isUserOverride: true } : {}) },
      resolvedValue: resolvedVal,
      rejectedEvidences: [],
    };
  }
  let winningEvidence = best;
  if (field === 'creators' || field === 'authors') {
    winningEvidence = selectAuthoritativeCreatorVariant(sorted.map((ev) => ({ ev, sourceProvider: ev.sourceProvider, val: ev.normalizedValue, isUserOverride: isUserSourceProvider(ev.sourceProvider, ev.isUserOverride) }))).ev;
  } else if ((field === 'abstract' || field === 'abstractNote') && sorted.length > 1) {
    const nonBoilerplate = sorted.filter((ev) => typeof ev.normalizedValue === 'string' && ev.normalizedValue.trim().length > 0 && !ABSTRACT_BOILERPLATE_REGEX.test(ev.normalizedValue.trim()));
    const pool = nonBoilerplate.length > 0 ? nonBoilerplate : sorted;
    winningEvidence = pool[0];
    if (!isUserSourceProvider(winningEvidence.sourceProvider, winningEvidence.isUserOverride) && typeof winningEvidence.normalizedValue === 'string' && winningEvidence.normalizedValue.trim().length < 60) {
      const winnerLen = winningEvidence.normalizedValue.trim().length;
      const fuller = pool.slice(1).find((ev) => typeof ev.normalizedValue === 'string' && ev.normalizedValue.trim().length >= 50 && ev.normalizedValue.trim().length >= winnerLen * 1.5);
      if (fuller) winningEvidence = fuller;
    }
  }
  let conflict: CoalesceConflictDetail | undefined;
  if (sorted.length > 1 && typeof best.normalizedValue !== 'object') {
    const divergent = sorted.filter((e) => String(e.normalizedValue).toLowerCase() !== String(best.normalizedValue).toLowerCase());
    if (divergent.length > 0) {
      conflict = {
        field, description: `Divergent values found for field "${field}" across providers`,
        severity: divergent.some((e) => e.confidence >= 0.8) ? 'high' : 'medium',
        variants: sorted.map((e) => ({ sourceProvider: e.sourceProvider, value: e.normalizedValue, confidenceScore: e.confidence })),
      };
    }
  }
  return {
    winningEvidence: stripAnnotation(winningEvidence),
    resolvedValue: winningEvidence.normalizedValue,
    rejectedEvidences: sorted.filter((e) => e !== winningEvidence).map(stripAnnotation),
    conflict,
  };
}

export class MetadataCoalescePolicy {
  static verifyCandidateMatch = verifyCandidateMatch;
  static evaluateCitationTrap = evaluateCitationTrap;
  static verifyTitleLookupCorroboration = verifyTitleLookupCorroboration;
  static extractNormalizedAuthorSurnames = extractNormalizedAuthorSurnames;
  static isSameCanonicalIdentifier = isSameCanonicalIdentifier;
  static isRejectedCitedIdentifier = isRejectedCitedIdentifier;

  static coalesceCandidates(candidates: CoalesceMetadataCandidate[]): CoalesceDecision {
    if (!candidates || candidates.length === 0) {
      return { selectedFields: {}, rejectedFields: {}, conflicts: [], proposedItem: { title: 'Untitled Record' }, decidedAt: new Date().toISOString(), policyVersion: '2.0.0' };
    }
    const fieldMap = new Map<string, CoalesceFieldEvidence[]>();
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== 'object') continue;
      const candAny = candidate as unknown as { source?: string; sourceProvider?: string; metadata?: Record<string, unknown>; isUserOverride?: boolean };
      const isAlreadyWeighted = candidate.sourceName === 'EnrichedProvider' || candAny.source === 'EnrichedProvider' || candAny.sourceProvider === 'EnrichedProvider';
      let fieldEvidences = candidate.fields;
      if (!fieldEvidences || Object.keys(fieldEvidences).length === 0) {
        const rawMeta = (candidate.normalizedMetadata as Record<string, unknown>) ?? candAny.metadata;
        if (!rawMeta || typeof rawMeta !== 'object') continue;
        const defaultProv = candAny.sourceProvider || candAny.source || candidate.sourceName || 'Unknown';
        const defaultConf = typeof candidate.confidenceScore === 'number' ? candidate.confidenceScore : 0.9;
        const defaultTime = candidate.retrievedAt || new Date().toISOString();
        const isCandUser = isUserSourceProvider(defaultProv, candAny.isUserOverride);
        fieldEvidences = {};
        for (const [k, v] of Object.entries(rawMeta)) {
          if (v !== undefined && v !== null) fieldEvidences[k] = { path: k, value: v, normalizedValue: v, confidence: defaultConf, sourceProvider: defaultProv, retrievedAt: defaultTime, ...(isCandUser ? { isUserOverride: true } : {}) };
        }
      }
      const harmonizedMeta: Record<string, unknown> = {};
      let fallbackEvidence: CoalesceFieldEvidence | undefined;
      for (const [key, evidence] of Object.entries(fieldEvidences)) {
        if (!evidence || evidence.normalizedValue === undefined || evidence.normalizedValue === null) continue;
        if (!fallbackEvidence && !isUserSourceProvider(evidence.sourceProvider, evidence.isUserOverride)) fallbackEvidence = evidence;
        harmonizedMeta[key] = evidence.normalizedValue;
      }
      if (!fallbackEvidence) fallbackEvidence = Object.values(fieldEvidences).find((ev): ev is CoalesceFieldEvidence => Boolean(ev) && ev.normalizedValue !== undefined && ev.normalizedValue !== null);
      if (!fallbackEvidence) continue;
      const candType = String(harmonizedMeta.itemType || candidate.normalizedMetadata?.itemType || 'journalArticle');
      resolveFieldAliases(harmonizedMeta);
      resolveBidirectionalBaseFields(harmonizedMeta, candType, undefined, false);
      if (harmonizedMeta.abstractNote !== undefined && harmonizedMeta.abstract === undefined) harmonizedMeta.abstract = harmonizedMeta.abstractNote;
      for (const [key, normVal] of Object.entries(harmonizedMeta)) {
        if (normVal === undefined || normVal === null || normVal === '' || (Array.isArray(normVal) && normVal.length === 0)) continue;
        const effectiveBase = fieldEvidences[key] || (ALIAS_EVIDENCE_FALLBACK_KEYS[key] || []).map((fk) => fieldEvidences[fk]).find(Boolean) || fallbackEvidence;
        const resolvedProvider =
          (effectiveBase.sourceProvider && effectiveBase.sourceProvider !== 'EnrichedProvider' && effectiveBase.sourceProvider !== 'MetadataResolution'
            ? effectiveBase.sourceProvider : (effectiveBase as { source?: string }).source) ||
          effectiveBase.sourceProvider || candAny.sourceProvider || candidate.sourceName || 'UNKNOWN';
        const evidenceToPush: CoalesceFieldEvidence =
          effectiveBase.path === key && effectiveBase.normalizedValue === normVal && effectiveBase.sourceProvider === resolvedProvider && !isAlreadyWeighted
            ? effectiveBase
            : { ...effectiveBase, path: key, normalizedValue: normVal, sourceProvider: resolvedProvider, ...(isAlreadyWeighted ? { __isAlreadyWeighted: true } : {}) };
        const existing = fieldMap.get(key) || [];
        existing.push(evidenceToPush);
        fieldMap.set(key, existing);
      }
    }
    const selectedFields: Record<string, CoalesceFieldEvidence> = {}, rejectedFields: Record<string, CoalesceFieldEvidence[]> = {}, conflicts: CoalesceConflictDetail[] = [], proposedItem: Record<string, unknown> = {};
    for (const [field, evidences] of fieldMap.entries()) {
      if ((field === 'tags' || field === 'labels' || field === 'keywords') && (proposedItem.tags !== undefined || proposedItem.keywords !== undefined || proposedItem.labels !== undefined)) {
        const cachedTags = (proposedItem.tags ?? proposedItem.keywords ?? proposedItem.labels) as string[];
        const cachedEv = selectedFields.tags ?? selectedFields.keywords ?? selectedFields.labels ?? evidences[0];
        const isBestUser = isUserSourceProvider(cachedEv.sourceProvider, cachedEv.isUserOverride);
        selectedFields[field] = { ...cachedEv, path: field, normalizedValue: cachedTags, ...(isBestUser ? { isUserOverride: true } : {}) };
        proposedItem[field] = cachedTags;
        rejectedFields[field] = [];
        continue;
      }
      const coalesced = coalesceMetadataValues(field, evidences);
      if (coalesced.winningEvidence) {
        selectedFields[field] = coalesced.winningEvidence;
        proposedItem[field] = coalesced.resolvedValue;
        rejectedFields[field] = coalesced.rejectedEvidences;
        if (coalesced.conflict) conflicts.push(coalesced.conflict);
      }
    }
    finalizeReconciledBibliographicMetadata(proposedItem, candidates.map((c) => ({ sourceProvider: (c as { sourceProvider?: string }).sourceProvider || c.sourceName, metadata: (c.normalizedMetadata as unknown as Record<string, unknown>) ?? (c as { metadata?: Record<string, unknown> }).metadata ?? (c.fields as unknown as Record<string, unknown>) })));
    for (const sKey of Object.keys(selectedFields)) {
      if (proposedItem[sKey] === undefined) delete selectedFields[sKey];
    }
    for (const syncKey of ['publicationDate', 'date', 'authors', 'creators', 'itemType', 'publicationTitle', 'journal', 'proceedingsTitle', 'bookTitle', 'extra'] as const) {
      if (selectedFields[syncKey] && proposedItem[syncKey] !== undefined && selectedFields[syncKey].normalizedValue !== proposedItem[syncKey]) selectedFields[syncKey] = { ...selectedFields[syncKey], normalizedValue: proposedItem[syncKey] };
    }
    const fieldProvenance: Record<string, { source: string; sourceProvider: string; confidence: number; verified: boolean; isUserOverride?: boolean; lockedByUser?: boolean }> = {};
    const userOverrideFieldKeys = new Set<string>();
    for (const [fKey, fEv] of Object.entries(selectedFields)) {
      if (!fEv || fKey === 'extraFields' || fKey === 'notes') continue;
      const isUser = isUserSourceProvider(fEv.sourceProvider, fEv.isUserOverride);
      if (isUser) userOverrideFieldKeys.add(fKey);
      fieldProvenance[fKey] = { source: fEv.sourceProvider, sourceProvider: fEv.sourceProvider, confidence: fEv.confidence, verified: fEv.confidence >= 0.7 || isUser, ...(isUser ? { isUserOverride: true, lockedByUser: true } : {}) };
    }
    const existingExtra = proposedItem.extraFields && typeof proposedItem.extraFields === 'object' && !Array.isArray(proposedItem.extraFields) ? (proposedItem.extraFields as Record<string, unknown>) : {};
    const existingFieldProv = existingExtra.fieldProvenance && typeof existingExtra.fieldProvenance === 'object' && !Array.isArray(existingExtra.fieldProvenance) ? (existingExtra.fieldProvenance as Record<string, unknown>) : {};
    const existingLocked = Array.isArray(existingExtra.lockedFields) ? (existingExtra.lockedFields as string[]) : [];
    const mergedLockedFields = Array.from(new Set([...existingLocked, ...userOverrideFieldKeys]));
    proposedItem.extraFields = { ...existingExtra, fieldProvenance: { ...fieldProvenance, ...existingFieldProv }, ...(mergedLockedFields.length > 0 ? { lockedFields: mergedLockedFields } : {}) };
    return { selectedFields, rejectedFields, conflicts, proposedItem: proposedItem as ItemMetadata, decidedAt: new Date().toISOString(), policyVersion: '2.0.0' };
  }
  coalesce(candidates: CoalesceMetadataCandidate[]): CoalesceDecision { return MetadataCoalescePolicy.coalesceCandidates(candidates); }
  reconcile(candidates: CoalesceMetadataCandidate[]): CoalesceDecision { return MetadataCoalescePolicy.coalesceCandidates(candidates); }
}

export interface ReconcileBibliographicOptions {
  existingSourceProvider?: string;
  incomingSourceProvider?: string;
  existingConfidence?: number;
  incomingConfidence?: number;
}

/**
 * Unified entry point for reconciling either a list of `CoalesceMetadataCandidate`s or
 * an existing bibliographic record against an incoming record/candidate.
 */
export function reconcileBibliographicRecord(
  candidatesOrExisting: CoalesceMetadataCandidate[] | Record<string, unknown>,
  incoming?: Record<string, unknown>,
  options?: ReconcileBibliographicOptions,
): CoalesceDecision {
  if (Array.isArray(candidatesOrExisting)) return MetadataCoalescePolicy.coalesceCandidates(candidatesOrExisting);
  const now = new Date().toISOString();
  const toCandidate = (rec: Record<string, unknown>, id: string, defaultSource: string, defaultConf: number): CoalesceMetadataCandidate => {
    const prov = typeof rec.sourceProvider === 'string' && rec.sourceProvider.trim() ? rec.sourceProvider.trim()
      : typeof rec.source === 'string' && rec.source.trim() ? rec.source.trim() : defaultSource;
    const conf = typeof rec.confidenceScore === 'number' ? rec.confidenceScore : typeof rec.confidence === 'number' ? rec.confidence : defaultConf;
    return { candidateId: id, sourceKind: 'PROVIDER', sourceName: prov, sourceProvider: prov, retrievedAt: now, fields: {}, normalizedMetadata: rec as ItemMetadata, confidenceScore: conf };
  };
  const candidates: CoalesceMetadataCandidate[] = [toCandidate(candidatesOrExisting, 'existing-record', options?.existingSourceProvider || 'LocalPDF', options?.existingConfidence ?? 0.85)];
  if (incoming && typeof incoming === 'object') {
    candidates.push(toCandidate(incoming, 'incoming-record', options?.incomingSourceProvider || 'CrossRef', options?.incomingConfidence ?? 0.95));
  }
  return MetadataCoalescePolicy.coalesceCandidates(candidates);
}

export type ReconciliationDecision = CoalesceDecision;
export type FieldEvidence = CoalesceFieldEvidence;
export type MetadataCandidate = CoalesceMetadataCandidate;
