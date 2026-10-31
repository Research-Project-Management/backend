import { TITLE_SIMILARITY_STOPWORDS } from './academic-text.lexicon';
import { isPlaceholderItemTitle, titleSimilarity, hasAuthorAndYearCorroboration } from './academic-title.domain';
import { normalizeAcademicTags } from './tag.domain';
import { mergeZoteroExtraTextLines, resolveFieldAliases, resolveBidirectionalBaseFields } from './zotero-field-harmonizer.domain';
import { parseCreatorString } from './author.domain';
import { normalizeArxivId } from './identifier.domain';
import { ItemMetadata } from '../types/bibliographic.types';

export const BIBLIOGRAPHIC_STOPWORDS = TITLE_SIMILARITY_STOPWORDS;
export const TITLE_MATCH_SIMILARITY_THRESHOLD = 0.5;
export enum OriginTier { FILENAME_FALLBACK = 0, LOCAL_EXTRACTED = 1, SUPPLEMENTAL_GRAPH = 2, AUTHORITATIVE_REGISTRY = 3, USER_OVERRIDE = 4 }

const USER_OVERRIDE_PROVIDERS = new Set(['useroverride', 'user', 'manual', 'useridentifier']);
const AUTHORITATIVE_REGISTRY_PROVIDERS = new Set(['crossref', 'pubmed', 'arxiv', 'openlibrary', 'zoteroconnector', 'zoterosync', 'zotero', 'bibliographyrecord', 'enrichedprovider', 'metadataresolution', 'clientresolved', 'directidentifier']);
const SUPPLEMENTAL_GRAPH_PROVIDERS = new Set(['openalex', 'semanticscholar', 'dblp', 'europepmc', 'datacite', 'googlebooks', 'hal', 'doaj', 'core', 'unpaywall', 'bibtex', 'ris', 'csl_json']);
const LOCAL_EXTRACTED_PROVIDERS = new Set(['trustedpaper', 'stagedpdf', 'pdfmetadata', 'localpdfextraction', 'local_in_process', 'local_pdf', 'webtranslator', 'urlscraper', 'urlcapture', 'file', 'aimetadata']);
const TIER_BASE_WEIGHT: Readonly<Record<OriginTier, number>> = { [OriginTier.USER_OVERRIDE]: 10.0, [OriginTier.AUTHORITATIVE_REGISTRY]: 1.0, [OriginTier.SUPPLEMENTAL_GRAPH]: 0.85, [OriginTier.LOCAL_EXTRACTED]: 0.6, [OriginTier.FILENAME_FALLBACK]: 0.45 };

export function resolveProviderTier(provider: string | undefined, _field?: string): OriginTier {
  if (!provider || !provider.trim()) return OriginTier.FILENAME_FALLBACK;
  const lower = provider.trim().toLowerCase();
  if (USER_OVERRIDE_PROVIDERS.has(lower)) return OriginTier.USER_OVERRIDE;
  if (AUTHORITATIVE_REGISTRY_PROVIDERS.has(lower)) return OriginTier.AUTHORITATIVE_REGISTRY;
  if (SUPPLEMENTAL_GRAPH_PROVIDERS.has(lower)) return OriginTier.SUPPLEMENTAL_GRAPH;
  if (LOCAL_EXTRACTED_PROVIDERS.has(lower)) return OriginTier.LOCAL_EXTRACTED;
  return OriginTier.FILENAME_FALLBACK;
}

export function resolveProviderFieldWeight(provider: string | undefined, field?: string): number {
  if (!provider || !provider.trim()) return 0.5;
  const lower = provider.trim().toLowerCase(), fieldLower = (field ?? '').trim().toLowerCase();
  const tier = resolveProviderTier(lower, fieldLower);
  if (tier === OriginTier.USER_OVERRIDE) return TIER_BASE_WEIGHT[OriginTier.USER_OVERRIDE];
  if (fieldLower === 'doi' && lower === 'crossref') return 1.05;
  if ((fieldLower === 'pmid' || fieldLower === 'pmcid') && lower === 'pubmed') return 1.05;
  if ((fieldLower === 'arxivid' || fieldLower === 'archiveid') && lower === 'arxiv') return 1.05;
  return TIER_BASE_WEIGHT[tier];
}

export const PREPRINT_SERVER_VENUE_REGEX = /^(?:arxiv(?:\.org)?|corr|biorxiv|medrxiv|chemrxiv|techrxiv|ssrn|research\s+square|osf\s+preprints|hal|zenodo)(?:\s+preprints?|\s+e-?prints?)?$/i;
const AUTHORITATIVE_CREATOR_PROVIDERS = new Set(['crossref', 'pubmed', 'arxiv', 'enrichedprovider', 'openalex', 'semanticscholar', 'dblp', 'zoterosync', 'zotero', 'bibtex', 'ris']);
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
  return normalizeAcademicTags(candidateTags);
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
  return mergeZoteroExtraTextLines(variants);
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
  const isNonArxivDoi = Boolean(typeof resolved.doi === 'string' && resolved.doi.trim() && !/^10\.(?:48550\/arxiv\.|1101\/|21203\/|26434\/|20944\/)/i.test(resolved.doi.trim()));
  const rawVenue = String(resolved.publicationTitle || resolved.journal || '').trim();
  if (itemType === 'preprint' && isNonArxivDoi && rawVenue && !PREPRINT_SERVER_VENUE_REGEX.test(rawVenue)) {
    itemType = 'journalArticle';
    resolved.itemType = 'journalArticle';
    if (isValidArxivId) {
      resolved.arxivId = rawArxivCandidate;
      resolved.extra = mergeReconciledExtraText([resolved.extra, `arXiv: ${rawArxivCandidate}`]);
    }
  }
  if (itemType === 'journalArticle') {
    if (resolved.publicationTitle && !resolved.journal) resolved.journal = resolved.publicationTitle;
    else if (resolved.journal && !resolved.publicationTitle) resolved.publicationTitle = resolved.journal;
  } else if (itemType === 'preprint') {
    if (isValidArxivId && !isNonArxivDoi) {
      resolved.repository = resolved.repository || 'arXiv';
      resolved.archive = resolved.archive || 'arXiv';
      resolved.arxivId = rawArxivCandidate;
      resolved.archiveId = `arXiv:${rawArxivCandidate}`;
      resolved.doi = `10.48550/arXiv.${rawArxivCandidate}`;
    } else {
      resolved.repository = resolved.repository || resolved.institution || resolved.publicationTitle || resolved.journal || resolved.publisher;
    }
    for (const k of ['publicationTitle', 'journal', 'proceedingsTitle', 'conferenceName', 'bookTitle', 'series', 'volume', 'issue', 'pages', 'journalAbbr', 'journalAbbreviation', 'issn', 'isbn'] as const) {
      delete resolved[k];
      if (resolved.extraFields && typeof resolved.extraFields === 'object') delete (resolved.extraFields as Record<string, unknown>)[k];
    }
  }
  if (Array.isArray(resolved.creators) && resolved.creators.length > 0) {
    const creatorsList = resolved.creators as Array<{ creatorType?: string; fullName?: string; name?: string; firstName?: string; lastName?: string }>;
    const authorsList = resolved.authors as unknown[] | undefined;
    const authorCreators = creatorsList.filter((c) => c.creatorType === 'author' || !c.creatorType);
    const effectiveList = authorCreators.length > 0 ? authorCreators : creatorsList;
    if (!authorsList || authorsList.length === 0 || effectiveList.length > authorsList.length || (effectiveList.length === authorsList.length && countFullGivenNames(effectiveList) >= countFullGivenNames(authorsList))) {
      resolved.authors = effectiveList.map((c) => c.fullName || c.name || `${c.firstName || ''} ${c.lastName || ''}`.trim()).filter(Boolean);
    } else if (Array.isArray(authorsList) && (authorsList.length > effectiveList.length || countFullGivenNames(authorsList) > countFullGivenNames(effectiveList))) {
      resolved.creators = (authorsList as string[]).map((a, idx) => parseCreatorString(String(a), idx, 'author')).filter((c): c is NonNullable<typeof c> => c !== null);
    }
  } else if (Array.isArray(resolved.authors) && resolved.authors.length > 0 && (!Array.isArray(resolved.creators) || resolved.creators.length === 0)) {
    resolved.creators = (resolved.authors as string[]).map((a, idx) => parseCreatorString(a, idx, 'author')).filter((c): c is NonNullable<typeof c> => c !== null);
  }
}

export const finalizeBibliographicMetadata = finalizeReconciledBibliographicMetadata;

export function extractNormalizedAuthorSurnames(authorsOrCreators: unknown): Set<string> {
  const out = new Set<string>();
  const addRaw = (rawName: string) => {
    const trimmed = rawName.trim();
    if (!trimmed) return;
    const token = trimmed.includes(',') ? trimmed.split(',')[0].trim().split(/\s+/).pop() || '' : trimmed.split(/\s+/).pop() || '';
    const norm = token.replace(/[đĐ]/g, 'd').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    if (norm.length >= 2) out.add(norm);
  };
  const processArray = (arr: unknown[]) => {
    for (const entry of arr) {
      if (typeof entry === 'string') addRaw(entry);
      else if (entry && typeof entry === 'object') {
        const obj = entry as { lastName?: string; family?: string; fullName?: string; name?: string };
        addRaw(String((typeof obj.lastName === 'string' && obj.lastName.trim() ? obj.lastName : typeof obj.family === 'string' && obj.family.trim() ? obj.family : obj.fullName || obj.name) || ''));
      }
    }
  };
  if (Array.isArray(authorsOrCreators)) processArray(authorsOrCreators);
  else if (authorsOrCreators && typeof authorsOrCreators === 'object') {
    const rec = authorsOrCreators as Record<string, unknown>;
    for (const k of ['creators', 'contributors', 'authors'] as const) {
      if (Array.isArray(rec[k]) && (rec[k] as unknown[]).length > 0) { processArray(rec[k] as unknown[]); if (out.size > 0) break; }
    }
  }
  return out;
}

export function evaluateCitationTrap(localMeta: Record<string, unknown>, resolvedMeta: Record<string, unknown>, isFilenameFallback?: boolean): { isTrap: boolean; similarity: number; rejectedDoi?: string } {
  const localExtra = localMeta.extraFields && typeof localMeta.extraFields === 'object' ? (localMeta.extraFields as Record<string, unknown>) : {};
  const effectiveFilenameFallback = isFilenameFallback ?? Boolean(localExtra.isFilenameTitle || localMeta.isFilenameTitle);
  const pdfTitle = typeof localMeta.title === 'string' ? localMeta.title.trim() : '';
  const isCrediblePdfTitle = !effectiveFilenameFallback && pdfTitle.length >= 10 && !isPlaceholderItemTitle(pdfTitle) && !/^manuscript$/i.test(pdfTitle) && !/^\d{4}\s*\d{4,5}(v\d+)?$/i.test(pdfTitle) && !/^arxiv/i.test(pdfTitle);
  const resolvedTitle = typeof resolvedMeta.title === 'string' ? resolvedMeta.title.trim() : '';
  if (!isCrediblePdfTitle || !resolvedTitle) return { isTrap: false, similarity: 1 };
  const similarity = titleSimilarity(resolvedTitle, pdfTitle);
  if (similarity < 0.4 && !hasAuthorAndYearCorroboration(localMeta, resolvedMeta)) {
    const rejectedDoi = (typeof resolvedMeta.doi === 'string' && resolvedMeta.doi.trim()) || (typeof localMeta.doi === 'string' && localMeta.doi.trim()) || undefined;
    return { isTrap: true, similarity, rejectedDoi };
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
  candidateId: string; sourceKind: 'IDENTIFIER' | 'RECORD' | 'URL' | 'FILE' | 'PROVIDER' | 'CONNECTOR';
  sourceName: string; sourceProvider?: string; sourceRecordId?: string;
  retrievedAt: string; schemaVersion?: string; rawEvidenceRef?: string;
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
    const rVal = rMeta[idKey]?.trim().toLowerCase(), pVal = pMeta[idKey]?.trim().toLowerCase();
    if (rVal && pVal && rVal !== pVal) return false;
  }
  const rYear = Number(rMeta.year), pYear = Number(pMeta.year);
  if (Number.isFinite(rYear) && rYear > 0 && Number.isFinite(pYear) && pYear > 0 && Math.abs(rYear - pYear) > 1) return false;
  const rAuthors = extractNormalizedAuthorSurnames(rMeta.authors?.length ? rMeta.authors : rMeta.creators);
  const pAuthors = extractNormalizedAuthorSurnames(pMeta.authors?.length ? pMeta.authors : pMeta.creators);
  if (rAuthors.size > 0 && pAuthors.size > 0 && ![...rAuthors].some((name) => pAuthors.has(name))) return false;
  if (providerCand.rawEvidenceRef && recordCand.candidateId && providerCand.rawEvidenceRef !== recordCand.candidateId) {
    for (const idKey of ['doi', 'arxivId', 'pmid', 'isbn'] as const) {
      const rVal = rMeta[idKey]?.trim().toLowerCase(), pVal = pMeta[idKey]?.trim().toLowerCase();
      if ((rVal || pVal) && rVal !== pVal) return false;
    }
    if ((rAuthors.size === 0) !== (pAuthors.size === 0)) return false;
  }
  return true;
}

export class MetadataCoalescePolicy {
  static verifyCandidateMatch = verifyCandidateMatch;
  static evaluateCitationTrap = evaluateCitationTrap;
  static verifyTitleLookupCorroboration = verifyTitleLookupCorroboration;
  static extractNormalizedAuthorSurnames = extractNormalizedAuthorSurnames;

  private static isUserSource(provider?: string, isUserOverride?: boolean): boolean {
    return Boolean(isUserOverride || resolveProviderTier(provider) === OriginTier.USER_OVERRIDE);
  }
  private static getProviderPriority(provider: string, field?: string, isAlreadyWeighted?: boolean, isUserOverride?: boolean): number {
    if (MetadataCoalescePolicy.isUserSource(provider, isUserOverride)) return 1000;
    if (isAlreadyWeighted && (!provider || provider === 'EnrichedProvider' || provider === 'MetadataResolution')) return 100;
    return resolveProviderFieldWeight(provider, field ?? '') * 100;
  }

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
        const isCandUser = MetadataCoalescePolicy.isUserSource(defaultProv, candAny.isUserOverride);
        fieldEvidences = {};
        for (const [k, v] of Object.entries(rawMeta)) {
          if (v !== undefined && v !== null) fieldEvidences[k] = { path: k, value: v, normalizedValue: v, confidence: defaultConf, sourceProvider: defaultProv, retrievedAt: defaultTime, ...(isCandUser ? { isUserOverride: true } : {}) };
        }
      }
      const harmonizedMeta: Record<string, unknown> = {};
      let fallbackEvidence: CoalesceFieldEvidence | undefined;
      for (const [key, evidence] of Object.entries(fieldEvidences)) {
        if (!evidence || evidence.normalizedValue === undefined || evidence.normalizedValue === null) continue;
        if (!fallbackEvidence && !MetadataCoalescePolicy.isUserSource(evidence.sourceProvider, evidence.isUserOverride)) fallbackEvidence = evidence;
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
          effectiveBase.sourceProvider || candAny.sourceProvider || candidate.sourceName;
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
    const stripAnnotation = (ev: CoalesceFieldEvidence): CoalesceFieldEvidence => {
      if (!('__isAlreadyWeighted' in ev)) return ev;
      const { __isAlreadyWeighted: _, ...clean } = ev;
      return clean;
    };
    for (const [field, evidences] of fieldMap.entries()) {
      const sorted = [...evidences].sort((a, b) => {
        const scoreA = a.confidence * MetadataCoalescePolicy.getProviderPriority(a.sourceProvider, field, a.__isAlreadyWeighted, a.isUserOverride);
        const scoreB = b.confidence * MetadataCoalescePolicy.getProviderPriority(b.sourceProvider, field, b.__isAlreadyWeighted, b.isUserOverride);
        return scoreB !== scoreA ? scoreB - scoreA : resolveProviderFieldWeight(b.sourceProvider, field) - resolveProviderFieldWeight(a.sourceProvider, field);
      });
      const best = sorted[0], isBestUser = MetadataCoalescePolicy.isUserSource(best.sourceProvider, best.isUserOverride);
      if (field === 'extra' || field === 'extraFields') {
        const resolvedVal = field === 'extra' && sorted.some((ev) => typeof ev.normalizedValue === 'string')
          ? mergeReconciledExtraText(sorted.map((ev) => ev.normalizedValue))
          : sorted.slice().reverse().reduce<Record<string, unknown>>((acc, ev) => ({ ...acc, ...(ev.normalizedValue && typeof ev.normalizedValue === 'object' ? (ev.normalizedValue as Record<string, unknown>) : {}) }), {});
        selectedFields[field] = { ...stripAnnotation(best), normalizedValue: resolvedVal };
        proposedItem[field] = resolvedVal;
        rejectedFields[field] = [];
        continue;
      }
      if (field === 'tags' || field === 'labels' || field === 'keywords' || field === 'notes') {
        const pool = isBestUser ? [best] : sorted;
        const resolvedVal = field === 'notes' ? mergeReconciledNotesArrays(pool.map((ev) => ev.normalizedValue), true) : mergeReconciledTagArrays(pool.map((ev) => ev.normalizedValue));
        selectedFields[field] = { ...stripAnnotation(best), normalizedValue: resolvedVal, ...(isBestUser ? { isUserOverride: true } : {}) };
        proposedItem[field] = resolvedVal;
        rejectedFields[field] = [];
        continue;
      }
      let winningEvidence = best;
      if (field === 'creators' || field === 'authors') {
        winningEvidence = selectAuthoritativeCreatorVariant(sorted.map((ev) => ({ ev, sourceProvider: ev.sourceProvider, val: ev.normalizedValue, isUserOverride: MetadataCoalescePolicy.isUserSource(ev.sourceProvider, ev.isUserOverride) }))).ev;
      } else if ((field === 'abstract' || field === 'abstractNote') && sorted.length > 1) {
        const nonBoilerplate = sorted.filter((ev) => typeof ev.normalizedValue === 'string' && ev.normalizedValue.trim().length > 0 && !ABSTRACT_BOILERPLATE_REGEX.test(ev.normalizedValue.trim()));
        const pool = nonBoilerplate.length > 0 ? nonBoilerplate : sorted;
        winningEvidence = pool[0];
        if (!MetadataCoalescePolicy.isUserSource(winningEvidence.sourceProvider, winningEvidence.isUserOverride) && typeof winningEvidence.normalizedValue === 'string' && winningEvidence.normalizedValue.trim().length < 60) {
          const winnerLen = winningEvidence.normalizedValue.trim().length;
          const fuller = pool.slice(1).find((ev) => typeof ev.normalizedValue === 'string' && ev.normalizedValue.trim().length >= 50 && ev.normalizedValue.trim().length >= winnerLen * 1.5);
          if (fuller) winningEvidence = fuller;
        }
      }
      selectedFields[field] = stripAnnotation(winningEvidence);
      proposedItem[field] = winningEvidence.normalizedValue;
      rejectedFields[field] = sorted.filter((e) => e !== winningEvidence).map(stripAnnotation);
      if (sorted.length > 1 && typeof best.normalizedValue !== 'object') {
        const divergent = sorted.filter((e) => String(e.normalizedValue).toLowerCase() !== String(best.normalizedValue).toLowerCase());
        if (divergent.length > 0) {
          conflicts.push({
            field, description: `Divergent values found for field "${field}" across providers`,
            severity: divergent.some((e) => e.confidence >= 0.8) ? 'high' : 'medium',
            variants: sorted.map((e) => ({ sourceProvider: e.sourceProvider, value: e.normalizedValue, confidenceScore: e.confidence })),
          });
        }
      }
    }
    finalizeReconciledBibliographicMetadata(proposedItem, candidates.map((c) => ({ sourceProvider: (c as { sourceProvider?: string }).sourceProvider || c.sourceName, metadata: (c.normalizedMetadata as unknown as Record<string, unknown>) ?? (c as { metadata?: Record<string, unknown> }).metadata ?? (c.fields as unknown as Record<string, unknown>) })));
    for (const syncKey of ['publicationDate', 'date', 'authors', 'creators', 'itemType', 'publicationTitle', 'journal', 'extra'] as const) {
      if (selectedFields[syncKey] && proposedItem[syncKey] !== undefined && selectedFields[syncKey].normalizedValue !== proposedItem[syncKey]) selectedFields[syncKey] = { ...selectedFields[syncKey], normalizedValue: proposedItem[syncKey] };
    }
    const fieldProvenance: Record<string, { source: string; sourceProvider: string; confidence: number; verified: boolean; isUserOverride?: boolean; lockedByUser?: boolean }> = {};
    const userOverrideFieldKeys = new Set<string>();
    for (const [fKey, fEv] of Object.entries(selectedFields)) {
      if (!fEv || fKey === 'extraFields' || fKey === 'notes') continue;
      const isUser = MetadataCoalescePolicy.isUserSource(fEv.sourceProvider, fEv.isUserOverride);
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
export type ReconciliationDecision = CoalesceDecision;
export type ConflictDetail = CoalesceConflictDetail;
export type FieldEvidence = CoalesceFieldEvidence;
export type MetadataCandidate = CoalesceMetadataCandidate;
