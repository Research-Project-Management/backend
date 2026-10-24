import { Prisma } from '@prisma/client';
import {
  normalizeDoi,
  normalizeArxivId,
  normalizePmid,
  normalizePmcid,
  normalizeIsbn,
  normalizeIssn,
  cleanBannedString,
} from '@/modules/library/core';
import { ItemDetail } from '@/modules/library/core/types/bibliographic.types';

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
    const key = match[1].trim().toLowerCase().replace(/[\s_]+/g, '-');
    result[key] = match[2].trim();
  }
  for (const line of extraStr.split(/\r?\n/)) {
    const m = line.trim().match(/^([a-zA-Z_][a-zA-Z0-9_.\s-]{0,40}):\s*(.+)$/);
    if (m) {
      const key = m[1].trim().toLowerCase().replace(/[\s_]+/g, '-');
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
    doi: cleanSingleIdentifier(pickFirst(['doi', 'DOI'], ['doi']), normalizeDoi),
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

export const IDENTIFIER_URI_BUILDERS: ReadonlyArray<{
  type: 'doi' | 'arxiv' | 'pmid' | 'pmcid' | 'isbn' | 'issn';
  key: keyof ReturnType<typeof normalizeItemIdentifiers>;
  buildUri: (val: string) => string;
}> = [
  { type: 'doi', key: 'doi', buildUri: (v) => `https://doi.org/${v}` },
  {
    type: 'arxiv',
    key: 'arxivId',
    buildUri: (v) => `https://arxiv.org/abs/${v}`,
  },
  {
    type: 'pmid',
    key: 'pmid',
    buildUri: (v) => `https://pubmed.ncbi.nlm.nih.gov/${v}/`,
  },
  {
    type: 'pmcid',
    key: 'pmcid',
    buildUri: (v) => `https://www.ncbi.nlm.nih.gov/pmc/articles/${v}/`,
  },
  { type: 'isbn', key: 'isbn', buildUri: (v) => `urn:isbn:${v}` },
  { type: 'issn', key: 'issn', buildUri: (v) => `urn:issn:${v}` },
];

export function calculateIdentifierChanges(
  cleanIds: ReturnType<typeof normalizeItemIdentifiers>,
  existing: ItemDetail | Record<string, unknown>,
): Array<{ type: string; value: string; canonicalUri: string }> {
  const existingArxivIdentifier = (
    existing.identifiers as Array<{ type: string; value?: string }> | undefined
  )?.find((identifierItem) => identifierItem.type === 'arxiv')?.value;

  const changes: Array<{ type: string; value: string; canonicalUri: string }> =
    [];
  for (const { type, key, buildUri } of IDENTIFIER_URI_BUILDERS) {
    const newVal = cleanIds[key];
    const currentVal =
      type === 'arxiv' ? existingArxivIdentifier : existing[key];
    if (newVal !== undefined && newVal !== currentVal) {
      changes.push({
        type,
        value: newVal,
        canonicalUri: newVal ? buildUri(newVal) : '',
      });
    }
  }
  return changes;
}

export function buildMyPublicationMetadata(
  existingMetadata: unknown,
  isMyPublication: boolean,
  options?: {
    contributorId?: string | null;
    isPublic?: boolean;
    openAccessLicense?: string | null;
    includeAttachments?: boolean;
    includeNotes?: boolean;
    authorshipConfirmed?: boolean;
  },
): Record<string, unknown> {
  const metadataObj: Record<string, unknown> =
    typeof existingMetadata === 'object' &&
    existingMetadata !== null &&
    !Array.isArray(existingMetadata)
      ? { ...(existingMetadata as Record<string, unknown>) }
      : {};
  metadataObj.isMyPublication = isMyPublication;
  if (isMyPublication) {
    metadataObj.publicationConfirmedAt = new Date().toISOString();
    if (options?.openAccessLicense !== undefined) {
      metadataObj.openAccessLicense = options.openAccessLicense;
    }
    if (options?.isPublic !== undefined) {
      metadataObj.isPublicPublication = options.isPublic;
    }
    if (options?.contributorId !== undefined) {
      metadataObj.publicationContributorId = options.contributorId;
    }
    if (options?.includeAttachments !== undefined) {
      metadataObj.includeAttachmentsInMyPublications =
        options.includeAttachments;
    }
    if (options?.includeNotes !== undefined) {
      metadataObj.includeNotesInMyPublications = options.includeNotes;
    }
    if (options?.authorshipConfirmed !== undefined) {
      metadataObj.authorshipConfirmed = options.authorshipConfirmed;
    }
  } else {
    metadataObj.isMyPublication = false;
    delete metadataObj.publicationConfirmedAt;
    delete metadataObj.openAccessLicense;
    delete metadataObj.isPublicPublication;
    delete metadataObj.publicationContributorId;
    delete metadataObj.includeAttachmentsInMyPublications;
    delete metadataObj.includeNotesInMyPublications;
    delete metadataObj.authorshipConfirmed;
  }
  return metadataObj;
}

export function buildCollectionItemsUpdatePatch(data: { collectionIds?: string[] | null; collectionId?: string | null }): Prisma.CollectionItemUpdateManyWithoutItemNestedInput | undefined {
  if (data.collectionIds !== undefined) {
    const unique = Array.from(new Set((Array.isArray(data.collectionIds) ? data.collectionIds : []).filter((cid): cid is string => typeof cid === 'string' && cid.trim().length > 0)));
    return unique.length > 0 ? { deleteMany: {}, create: unique.map((cid, idx) => ({ collection: { connect: { id: cid } }, sortOrder: idx })) } : { deleteMany: {} };
  }
  if (data.collectionId !== undefined) {
    return data.collectionId && typeof data.collectionId === 'string' && data.collectionId.trim().length > 0 ? { deleteMany: {}, create: { collection: { connect: { id: data.collectionId.trim() } }, sortOrder: 0 } } : { deleteMany: {} };
  }
  return undefined;
}
