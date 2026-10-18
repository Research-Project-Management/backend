import { libraryConfig } from '@/modules/library/core/config/library.config';
import { buildTipTapDocFromText } from '@/modules/library/core/domain/tiptap.domain';
export { buildTipTapDocFromText };
import {
  normalizeDoi,
  normalizeArxivId,
  normalizePmid,
  normalizePmcid,
  normalizeIsbn,
  normalizeIssn,
  cleanBannedString,
  convertAcademicHtmlToMarkdown,
} from '@/modules/library/core';
import {
  ITEM_COLUMN_METADATA_FIELDS,
  FIELD_ALIASES,
} from '@/modules/library/catalog/types/items.constants';
import { isUUID } from 'class-validator';

export const isUuid = (val: unknown): val is string =>
  typeof val === 'string' &&
  Boolean(val) &&
  (libraryConfig().app.isTest || isUUID(val));

export function cleanSingleIdentifier(
  raw: string | null | undefined,
  normalizer: (val?: string | null) => string | undefined,
): string | undefined {
  if (raw === undefined) return undefined;
  if (!raw) return '';
  const cleaned = cleanBannedString(raw);
  return normalizer(cleaned) || cleaned || '';
}

export function extractExtraKeyValues(
  extraStr?: string | null,
): Record<string, string> {
  const result: Record<string, string> = {};
  if (!extraStr || typeof extraStr !== 'string') return result;

  for (const match of extraStr.matchAll(
    /\{:\s*([a-zA-Z_][a-zA-Z0-9_.\s-]*?)\s*:\s*([^}]+?)\s*\}/g,
  )) {
    const key = match[1]
      .trim()
      .toLowerCase()
      .replace(/[\s_]+/g, '-');
    result[key] = match[2].trim();
  }
  for (const line of extraStr.split(/\r?\n/)) {
    const m = line.trim().match(/^([a-zA-Z_][a-zA-Z0-9_.\s-]{0,40}):\s*(.+)$/);
    if (m) {
      const key = m[1]
        .trim()
        .toLowerCase()
        .replace(/[\s_]+/g, '-');
      if (!result[key]) {
        result[key] = m[2].trim();
      }
    }
  }
  return result;
}

export function normalizeItemIdentifiers(data: {
  doi?: string | null;
  DOI?: string | null;
  arxivId?: string | null;
  archiveID?: string | null;
  archiveId?: string | null;
  pmid?: string | null;
  PMID?: string | null;
  pmcid?: string | null;
  PMCID?: string | null;
  isbn?: string | null;
  ISBN?: string | null;
  issn?: string | null;
  ISSN?: string | null;
  extra?: string | null;
  extraFields?: Record<string, unknown> | null;
}) {
  const rec = data as Record<string, unknown>;
  const ef =
    data.extraFields && typeof data.extraFields === 'object'
      ? data.extraFields
      : {};
  const extraKv = extractExtraKeyValues(data.extra);

  const pickFirst = (
    keys: string[],
    extraKvKeys: string[],
  ): string | null | undefined => {
    for (const k of keys) {
      const v = rec[k] !== undefined ? rec[k] : ef[k];
      if (v === null) return null;
      if (typeof v === 'string') return v;
      if (typeof v === 'number') return String(v);
    }
    for (const ek of extraKvKeys) {
      if (extraKv[ek] !== undefined) return extraKv[ek];
    }
    return undefined;
  };

  return {
    doi: cleanSingleIdentifier(
      pickFirst(['doi', 'DOI'], ['doi']),
      normalizeDoi,
    ),
    arxivId: cleanSingleIdentifier(
      pickFirst(['arxivId', 'archiveID', 'archiveId'], ['arxiv', 'arxivid']),
      normalizeArxivId,
    ),
    pmid: cleanSingleIdentifier(
      pickFirst(['pmid', 'PMID'], ['pmid']),
      normalizePmid,
    ),
    pmcid: cleanSingleIdentifier(
      pickFirst(['pmcid', 'PMCID'], ['pmcid', 'pmc']),
      normalizePmcid,
    ),
    isbn: cleanSingleIdentifier(
      pickFirst(['isbn', 'ISBN'], ['isbn']),
      normalizeIsbn,
    ),
    issn: cleanSingleIdentifier(
      pickFirst(['issn', 'ISSN'], ['issn']),
      normalizeIssn,
    ),
  };
}

export function unpackExtraFromDb(rawExtra?: string | null): {
  cleanExtra: string;
  extraFields: Record<string, unknown>;
} {
  if (!rawExtra || typeof rawExtra !== 'string' || !rawExtra.trim()) {
    return { cleanExtra: '', extraFields: {} };
  }
  const trimmed = rawExtra.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const parsedObj = parsed as Record<string, unknown>;
        const cleanExtra =
          typeof parsedObj._rawExtra === 'string' ? parsedObj._rawExtra : '';
        const fields: Record<string, unknown> = { ...parsedObj };
        delete fields._rawExtra;
        return { cleanExtra, extraFields: fields };
      }
    } catch {
      // fallback to plain text
    }
  }
  return { cleanExtra: trimmed, extraFields: {} };
}

export function packExtraPayload(
  rawExtra: string | null | undefined,
  _extraFields?: Record<string, unknown> | null,
): string {
  const { cleanExtra } = unpackExtraFromDb(rawExtra);
  return cleanExtra;
}

export function resolveExtraPlainText(
  extraInput?: string | null,
  existingExtra?: string | null,
  patches?: Record<string, unknown> | null,
): string | undefined {
  const rawCandidate =
    (extraInput !== undefined && extraInput !== null
      ? extraInput
      : existingExtra) ?? '';
  const { cleanExtra: cleanRaw } = unpackExtraFromDb(rawCandidate);

  if (!patches || Object.keys(patches).length === 0) {
    return cleanRaw.trim() || undefined;
  }

  const patchLookup = new Map<string, unknown>();
  for (const [pKey, pVal] of Object.entries(patches)) {
    if (!pKey.startsWith('__')) {
      patchLookup.set(pKey.toLowerCase(), pVal);
    }
  }

  const updatedLines: string[] = [];
  for (const line of cleanRaw.split('\n')) {
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) {
      if (line.trim()) updatedLines.push(line);
      continue;
    }
    const linePrefix = line.slice(0, colonIndex).trim();
    const lineKey = linePrefix.toLowerCase();
    if (patchLookup.has(lineKey)) {
      const val = patchLookup.get(lineKey);
      if (
        (typeof val === 'string' && val !== '') ||
        typeof val === 'number' ||
        typeof val === 'boolean'
      ) {
        updatedLines.push(`${linePrefix}: ${String(val)}`);
      }
    } else {
      updatedLines.push(line);
    }
  }

  return updatedLines.join('\n').trim() || undefined;
}

const IGNORED_SYSTEM_KEYS = new Set([
  'id',
  'userId',
  'projectId',
  'workspaceId',
  'createdById',
  'uploadedById',
  'createdAt',
  'updatedAt',
  'deletedAt',
  'version',
  '_version',
  'expectedVersion',
  'isDeleted',
  'silent',
  'creators',
  'authors',
  'contributors',
  'editors',
  'tags',
  'labels',
  'itemTags',
  'zoteroTags',
  'keywords',
  'keywordsList',
  'attachments',
  'primaryFile',
  'filename',
  'notes',
  'notesList',
  'collectionId',
  'collectionIds',
  'collections',
  'collectionItems',
  'userStates',
  'states',
  'readStatus',
  'rating',
  'lastReadAt',
  'extraFields',
  'fileId',
  'fileUrl',
  'size',
  'mimeType',
  'hasFile',
  'attachmentCount',
  'noteCount',
  'firstAuthor',
  'outgoingRel',
  'incomingRel',
  'relations',
  'seeAlso',
  'identifiers',
  'ingestionRuns',
  'itemMetadata',
  'publications',
  'crossrefEnriched',
  'ragDocId',
  'ragIndexedAt',
  'ragLastAttemptAt',
  'ragAttempts',
  'ragError',
  'ragStatus',
  'isRetracted',
  'retraction',
  'retractionStatus',
  'retractionDate',
  'retractionNature',
  'retractionReasons',
  'retractionNoticeDoi',
  'retractionDetails',
  'retractionCheckedAt',
  'isMyPublication',
  'publicationConfirmedAt',
  'ingestionStatus',
  'extractionStatus',
  'verificationScore',
  'isVerified',
  'matchedSignals',
  'missingFields',
  'isSelfSufficient',
  'qualityScore',
  'engineUsed',
  'provenance',
  'fieldProvenance',
  'sourceProvider',
  'source',
  'sources',
  'confidenceScore',
  'originProvider',
  'canonicalId',
  'canonicalUrl',
  'resolvedAt',
  'warnings',
  'disambiguationWarning',
  'rejectedCitedDoi',
  'wafKind',
  'promptUploadPdf',
  'dismissedDuplicateIds',
  'mergedCitationKeys',
  'mergedFromIds',
]);

export function extractNonColumnExtraFields(
  data?: Record<string, unknown> | null,
  existingExtraFields?: Record<string, unknown> | null,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...(existingExtraFields || {}) };
  if (!data || typeof data !== 'object') return result;

  const copyNonColumn = (source: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(source)) {
      if (
        value !== undefined &&
        !IGNORED_SYSTEM_KEYS.has(key) &&
        !ITEM_COLUMN_METADATA_FIELDS.has(key) &&
        !FIELD_ALIASES[key]
      ) {
        result[key] = value;
      }
    }
  };

  copyNonColumn(data);
  if (data.extraFields && typeof data.extraFields === 'object') {
    copyNonColumn(data.extraFields as Record<string, unknown>);
  }
  return result;
}

export function convertHtmlToMarkdown(html: string): string {
  return convertAcademicHtmlToMarkdown(html);
}

// Sub-builders (SRP decomposition)
export * from './creator-tag-payload.builder';
export * from './item-create-payload.builder';
export * from './item-update-payload.builder';
