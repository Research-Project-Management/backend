import { Prisma } from '@prisma/client';
import { cleanAbstractText, sanitizeItemTitle } from '@/modules/library/core';
import {
  ItemDetail,
  UpdateItemData,
} from '@/modules/library/catalog/types/items.types';
import { TagInput } from '@/modules/library/catalog/types/tags.types';
import {
  normalizeItemIdentifiers,
  unpackExtraFromDb,
} from './command-payload.builder';
import {
  prepareNotesToCreate,
  prepareAttachmentsToCreate,
  deriveFirstAuthor,
  prepareContributorsToCreate,
} from './creator-tag-payload.builder';
import {
  resolveCanonicalCommandFields,
  buildMetadataPartial,
} from './item-create-payload.builder';

export function buildCommandUpdateInput(
  userId: string,
  existing: ItemDetail | Record<string, unknown>,
  data: UpdateItemData,
  options?: { skipVersionIncrement?: boolean },
): {
  updateData: Prisma.ItemUpdateInput;
  cleanIds: {
    doi?: string;
    arxivId?: string;
    pmid?: string;
    pmcid?: string;
    isbn?: string;
    issn?: string;
  };
  rawTags?: (TagInput | null | undefined)[];
} {
  const ids = normalizeItemIdentifiers(data);
  const targetItemType = (data.itemType ??
    data.type ??
    existing.itemType ??
    existing.type ??
    'journalArticle') as string;

  const rawTags = data.tags || data.keywords || data.labels;
  const { cleanExtra: existingRawExtra, extraFields: existingParsedFields } =
    unpackExtraFromDb(existing.extra as string | null | undefined);

  const canonical = resolveCanonicalCommandFields(
    data,
    targetItemType,
    existingParsedFields,
  );

  const cleanAbstract =
    canonical.rawAbstract !== undefined
      ? (cleanAbstractText(canonical.rawAbstract) ?? canonical.rawAbstract)
      : existing.abstract;

  const newNotesToCreate = prepareNotesToCreate(
    data.notes,
    userId,
    data.userId || (existing.uploadedById as string | undefined) || userId,
    existing.notesList,
  );

  const newAttachmentsToCreate =
    Array.isArray(data.attachments) && data.attachments.length > 0
      ? prepareAttachmentsToCreate(
          data.attachments.filter(
            (a: Record<string, unknown> | null | undefined) => !a?.id,
          ),
          null,
        )
      : [];

  const existingMeta: Record<string, unknown> =
    existing.metadata &&
    typeof existing.metadata === 'object' &&
    !Array.isArray(existing.metadata)
      ? (existing.metadata as Record<string, unknown>)
      : typeof existing.metadata === 'string' &&
          existing.metadata.trim().startsWith('{')
        ? (() => {
            try {
              const parsed: unknown = JSON.parse(existing.metadata);
              return parsed &&
                typeof parsed === 'object' &&
                !Array.isArray(parsed)
                ? (parsed as Record<string, unknown>)
                : {};
            } catch {
              return {};
            }
          })()
        : {};

  const updatedMetadata = buildMetadataPartial({
    mode: 'update',
    baseMeta: existingMeta,
    data,
    canonical,
    ids,
    rawTags,
    existingRawExtra,
  });

  const contributorsToUpdate = prepareContributorsToCreate(
    data,
    targetItemType,
  );

  const buildCollectionUpdate = () => {
    if (data.collectionIds !== undefined) {
      const unique = Array.from(
        new Set(
          (Array.isArray(data.collectionIds) ? data.collectionIds : []).filter(
            (cid: string): cid is string =>
              typeof cid === 'string' && cid.trim().length > 0,
          ),
        ),
      );
      return unique.length > 0
        ? {
            deleteMany: {},
            create: unique.map((cid, idx) => ({
              collection: { connect: { id: cid } },
              sortOrder: idx,
            })),
          }
        : { deleteMany: {} };
    }
    if (data.collectionId !== undefined) {
      return data.collectionId &&
        typeof data.collectionId === 'string' &&
        data.collectionId.trim().length > 0
        ? {
            deleteMany: {},
            create: {
              collection: { connect: { id: data.collectionId.trim() } },
              sortOrder: 0,
            },
          }
        : { deleteMany: {} };
    }
    return undefined;
  };

  const collectionItemsPatch = buildCollectionUpdate();

  const updateData: Prisma.ItemUpdateInput = {
    title:
      canonical.rawTitle !== undefined
        ? sanitizeItemTitle(canonical.rawTitle) || (existing.title as string)
        : (existing.title as string),
    itemType: targetItemType,
    ...(canonical.rawPubTitle !== undefined
      ? { publicationTitle: canonical.rawPubTitle }
      : {}),
    year: (data.year !== undefined
      ? data.year
      : canonical.extractedYear !== null
        ? canonical.extractedYear
        : existing.year) as number | null | undefined,
    doi: (ids.doi !== undefined ? ids.doi : existing.doi) as
      string | null | undefined,
    abstract: cleanAbstract as string | null | undefined,
    url: (canonical.rawUrl !== undefined ? canonical.rawUrl : existing.url) as
      string | null | undefined,
    citationKey: (canonical.rawCitationKey !== undefined
      ? canonical.rawCitationKey
      : existing.citationKey) as string | null | undefined,
    metadata: updatedMetadata as Prisma.InputJsonValue,
    ...(data.contributors !== undefined ||
    data.creators !== undefined ||
    data.authors !== undefined
      ? { firstAuthor: deriveFirstAuthor(data) }
      : {}),
    ...(collectionItemsPatch ? { collectionItems: collectionItemsPatch } : {}),
    ...(contributorsToUpdate !== null
      ? {
          contributors: {
            deleteMany: {},
            create: contributorsToUpdate,
          },
        }
      : {}),
    ...(newNotesToCreate.length > 0
      ? {
          notesList: { create: newNotesToCreate },
          noteCount:
            (Array.isArray(existing.notesList)
              ? existing.notesList.length
              : typeof existing.noteCount === 'number'
                ? existing.noteCount
                : 0) + newNotesToCreate.length,
        }
      : {}),
    ...(newAttachmentsToCreate.length > 0
      ? { attachments: { create: newAttachmentsToCreate } }
      : {}),
    ...(options?.skipVersionIncrement ? {} : { version: { increment: 1 } }),
  };

  return {
    updateData,
    cleanIds: ids,
    rawTags,
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
  cleanIds: {
    doi?: string;
    arxivId?: string;
    pmid?: string;
    pmcid?: string;
    isbn?: string;
    issn?: string;
  },
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
