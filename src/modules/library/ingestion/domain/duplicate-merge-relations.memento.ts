import { Prisma } from '@prisma/client';

export {
  restoreMasterRelationsInTx,
  restoreDuplicateRelationsInTx,
} from './duplicate-merge-restore.memento';

export interface MementoIdentifierRecord {
  type: string;
  value: string;
  canonicalUri?: string | null;
}

export interface MementoContributorRecord {
  creatorType?: string;
  fieldMode?: number;
  firstName?: string | null;
  lastName?: string | null;
  fullName?: string | null;
  shortName?: string | null;
  orderIndex?: number;
}

export interface MementoItemRelationRecord {
  id?: string;
  sourceItemId: string;
  targetItemId: string;
  relationType: string;
  description?: string | null;
}

export interface MementoUserPublicationRecord {
  userId: string;
  itemId?: string;
  contributorId?: string | null;
  isPublic?: boolean;
  openAccessLicense?: string | null;
  addedAt?: string | null;
}

export interface MementoUserStateRecord {
  userId: string;
  itemId?: string;
  isStarred?: boolean;
  rating?: number | null;
  readStatus?: string;
  currentPage?: number | null;
  scrollPosition?: unknown;
  lastOpenedAt?: string | null;
  lastReadAt?: string | null;
}

export interface MementoItemMetadataRecord {
  id?: string;
  itemId?: string;
  sourceProvider?: string;
  rawPayload?: unknown;
}

export interface MementoAttachmentRecord {
  id: string;
  attachmentType?: string | null;
}

export interface PreMergeItemRelations {
  attachmentIds?: string[];
  attachments?: MementoAttachmentRecord[];
  noteIds?: string[];
  tagIds?: string[];
  collectionIds?: string[];
  identifiers?: MementoIdentifierRecord[];
  contributors?: MementoContributorRecord[];
  itemRelations?: MementoItemRelationRecord[];
  userPublications?: MementoUserPublicationRecord[];
  userStates?: MementoUserStateRecord[];
  itemMetadata?: MementoItemMetadataRecord[];
}

export interface MasterItemSnapshot {
  id: string;
  title?: string;
  itemType?: string;
  year?: number | null;
  citationKey?: string | null;
  doi?: string | null;
  publicationTitle?: string | null;
  abstract?: string | null;
  url?: string | null;
  firstAuthor?: string | null;
  hasFile?: boolean;
  attachmentCount?: number;
  metadata?: Record<string, unknown>;
  attachmentIds?: string[];
  attachments?: MementoAttachmentRecord[];
  tagIds?: string[];
  collectionIds?: string[];
  contributors?: MementoContributorRecord[];
  identifiers?: MementoIdentifierRecord[];
  itemRelations?: MementoItemRelationRecord[];
  userPublications?: MementoUserPublicationRecord[];
  userStates?: MementoUserStateRecord[];
  itemMetadata?: MementoItemMetadataRecord[];
  [key: string]: unknown;
}

export type MasterPreMergeSnapshot = MasterItemSnapshot;

export interface MergedDuplicateSnapshot {
  id: string;
  title?: string;
  citationKey?: string | null;
  doi?: string | null;
  hasFile?: boolean;
  attachmentCount?: number;
  metadata?: Record<string, unknown>;
  attachmentIds?: string[];
  attachments?: MementoAttachmentRecord[];
  noteIds?: string[];
  tagIds?: string[];
  collectionIds?: string[];
  identifiers?: MementoIdentifierRecord[];
  contributors?: MementoContributorRecord[];
  itemRelations?: MementoItemRelationRecord[];
  userPublications?: MementoUserPublicationRecord[];
  userStates?: MementoUserStateRecord[];
  itemMetadata?: MementoItemMetadataRecord[];
}

export function asPlainObject(val: unknown): Record<string, unknown> {
  return val && typeof val === 'object' && !Array.isArray(val)
    ? (val as Record<string, unknown>)
    : {};
}

export function asStringArray(val: unknown): string[] | undefined {
  if (!Array.isArray(val)) return undefined;
  return val
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    .map((v) => v.trim());
}

export function extractIdentifiers(val: unknown): MementoIdentifierRecord[] | undefined {
  if (!Array.isArray(val)) return undefined;
  return val
    .filter((i): i is Record<string, unknown> =>
      Boolean(
        i &&
          typeof i === 'object' &&
          typeof (i as { type?: unknown }).type === 'string' &&
          typeof (i as { value?: unknown }).value === 'string',
      ),
    )
    .map((i) => ({
      type: String(i.type),
      value: String(i.value),
      ...(i.canonicalUri !== undefined
        ? { canonicalUri: i.canonicalUri as string | null }
        : {}),
    }));
}

export function extractContributors(val: unknown): MementoContributorRecord[] | undefined {
  if (!Array.isArray(val)) return undefined;
  return val
    .filter((c): c is Record<string, unknown> => Boolean(c && typeof c === 'object'))
    .map((c, idx) => ({
      ...(typeof c.creatorType === 'string' ? { creatorType: c.creatorType } : {}),
      ...(typeof c.fieldMode === 'number' ? { fieldMode: c.fieldMode } : {}),
      ...(c.firstName !== undefined ? { firstName: c.firstName as string | null } : {}),
      ...(c.lastName !== undefined ? { lastName: c.lastName as string | null } : {}),
      ...(c.fullName !== undefined ? { fullName: c.fullName as string | null } : {}),
      ...(c.shortName !== undefined ? { shortName: c.shortName as string | null } : {}),
      orderIndex: typeof c.orderIndex === 'number' ? c.orderIndex : idx,
    }));
}

export function extractItemRelations(val: unknown): MementoItemRelationRecord[] | undefined {
  if (!Array.isArray(val)) return undefined;
  return val
    .filter((r): r is Record<string, unknown> =>
      Boolean(
        r &&
          typeof r === 'object' &&
          typeof (r as { sourceItemId?: unknown }).sourceItemId === 'string' &&
          typeof (r as { targetItemId?: unknown }).targetItemId === 'string' &&
          typeof (r as { relationType?: unknown }).relationType === 'string',
      ),
    )
    .map((r) => ({
      ...(typeof r.id === 'string' ? { id: r.id } : {}),
      sourceItemId: String(r.sourceItemId),
      targetItemId: String(r.targetItemId),
      relationType: String(r.relationType),
      ...(r.description !== undefined ? { description: r.description as string | null } : {}),
    }));
}

export function extractUserPublications(val: unknown): MementoUserPublicationRecord[] | undefined {
  if (!Array.isArray(val)) return undefined;
  return val
    .filter((p): p is Record<string, unknown> =>
      Boolean(p && typeof p === 'object' && typeof (p as { userId?: unknown }).userId === 'string'),
    )
    .map((p) => ({
      userId: String(p.userId),
      ...(typeof p.itemId === 'string' ? { itemId: p.itemId } : {}),
      ...(p.contributorId !== undefined ? { contributorId: p.contributorId as string | null } : {}),
      ...(typeof p.isPublic === 'boolean' ? { isPublic: p.isPublic } : {}),
      ...(p.openAccessLicense !== undefined
        ? { openAccessLicense: p.openAccessLicense as string | null }
        : {}),
      ...(p.addedAt instanceof Date
        ? { addedAt: p.addedAt.toISOString() }
        : typeof p.addedAt === 'string'
          ? { addedAt: p.addedAt }
          : {}),
    }));
}

export function extractUserStates(val: unknown): MementoUserStateRecord[] | undefined {
  if (!Array.isArray(val)) return undefined;
  return val
    .filter((s): s is Record<string, unknown> =>
      Boolean(s && typeof s === 'object' && typeof (s as { userId?: unknown }).userId === 'string'),
    )
    .map((s) => ({
      userId: String(s.userId),
      ...(typeof s.itemId === 'string' ? { itemId: s.itemId } : {}),
      ...(typeof s.isStarred === 'boolean' ? { isStarred: s.isStarred } : {}),
      ...(s.rating !== undefined ? { rating: s.rating as number | null } : {}),
      ...(typeof s.readStatus === 'string' ? { readStatus: s.readStatus } : {}),
      ...(s.currentPage !== undefined ? { currentPage: s.currentPage as number | null } : {}),
      ...(s.scrollPosition !== undefined ? { scrollPosition: s.scrollPosition } : {}),
      ...(s.lastOpenedAt instanceof Date
        ? { lastOpenedAt: s.lastOpenedAt.toISOString() }
        : typeof s.lastOpenedAt === 'string'
          ? { lastOpenedAt: s.lastOpenedAt }
          : {}),
      ...(s.lastReadAt instanceof Date
        ? { lastReadAt: s.lastReadAt.toISOString() }
        : typeof s.lastReadAt === 'string'
          ? { lastReadAt: s.lastReadAt }
          : {}),
    }));
}

export function extractItemMetadata(val: unknown): MementoItemMetadataRecord[] | undefined {
  if (!Array.isArray(val)) return undefined;
  return val
    .filter((m): m is Record<string, unknown> => Boolean(m && typeof m === 'object'))
    .map((m) => ({
      ...(typeof m.id === 'string' ? { id: m.id } : {}),
      ...(typeof m.itemId === 'string' ? { itemId: m.itemId } : {}),
      ...(typeof m.sourceProvider === 'string' ? { sourceProvider: m.sourceProvider } : {}),
      ...(m.rawPayload !== undefined ? { rawPayload: m.rawPayload } : {}),
    }));
}

export function extractAttachments(val: unknown): MementoAttachmentRecord[] | undefined {
  if (!Array.isArray(val)) return undefined;
  return val
    .filter((a): a is Record<string, unknown> =>
      Boolean(a && typeof a === 'object' && typeof (a as { id?: unknown }).id === 'string'),
    )
    .map((a) => ({
      id: String(a.id),
      ...(typeof a.attachmentType === 'string' || a.attachmentType === null
        ? { attachmentType: a.attachmentType as string | null }
        : {}),
    }));
}

export function extractNestedIds(arr: unknown, nestedKey: string): string[] | undefined {
  if (!Array.isArray(arr)) return undefined;
  return arr
    .map((entry) => {
      if (typeof entry === 'string') return entry;
      if (entry && typeof entry === 'object') {
        const rec = entry as Record<string, unknown>;
        if (typeof rec[nestedKey] === 'string') return rec[nestedKey] as string;
        const sub = rec[nestedKey.replace(/Id$/, '')];
        if (sub && typeof sub === 'object' && typeof (sub as { id?: unknown }).id === 'string') {
          return (sub as { id: string }).id;
        }
        if (typeof rec.id === 'string') return rec.id;
      }
      return '';
    })
    .filter((v) => v.length > 0);
}

export async function capturePreMergeRelationsInTx(params: {
  tx: Prisma.TransactionClient;
  primary: Record<string, unknown> & { id: string };
  duplicates: Array<Record<string, unknown> & { id: string }>;
  uniqueDupIds: string[];
  initialNotes?: Array<{ id: string; itemId?: string | null }>;
  initialAttachments?: Array<{ id: string; itemId?: string | null; attachmentType?: string | null }>;
}): Promise<{
  primaryRelations: PreMergeItemRelations;
  duplicateRelationsById: Record<string, PreMergeItemRelations>;
}> {
  const { tx, primary, duplicates, uniqueDupIds, initialNotes, initialAttachments } = params;
  const allIds = [primary.id, ...uniqueDupIds];
  const dynTx = tx as unknown as {
    state?: { findMany?: (args: Record<string, unknown>) => Promise<Array<Record<string, unknown>>> };
    itemIdentifier?: {
      findMany?: (args: Record<string, unknown>) => Promise<
        Array<{
          itemId: string;
          type: string;
          value: string;
          canonicalUri?: string | null;
        }>
      >;
    };
  };

  const [rawItemTags, rawCollectionItems, rawIdentifiers, rawContribs, rawStates, queriedNotes, queriedAttachments] =
    await Promise.all([
      typeof tx.itemTag?.findMany === 'function'
        ? tx.itemTag.findMany({ where: { itemId: { in: allIds } }, select: { itemId: true, tagId: true } })
        : Promise.resolve(undefined),
      typeof tx.collectionItem?.findMany === 'function'
        ? tx.collectionItem.findMany({ where: { itemId: { in: allIds } }, select: { itemId: true, collectionId: true } })
        : Promise.resolve(undefined),
      typeof dynTx.itemIdentifier?.findMany === 'function'
        ? dynTx.itemIdentifier.findMany({ where: { itemId: { in: allIds } } })
        : Promise.resolve(undefined),
      typeof tx.contributor?.findMany === 'function'
        ? tx.contributor.findMany({ where: { itemId: { in: allIds } }, orderBy: { orderIndex: 'asc' } })
        : Promise.resolve(undefined),
      typeof dynTx.state?.findMany === 'function'
        ? dynTx.state.findMany({ where: { itemId: { in: allIds } } })
        : Promise.resolve(undefined),
      initialNotes === undefined && typeof tx.note?.findMany === 'function'
        ? tx.note.findMany({ where: { itemId: { in: allIds } }, select: { id: true, itemId: true } })
        : Promise.resolve(initialNotes),
      typeof tx.attachment?.findMany === 'function'
        ? tx.attachment.findMany({
            where: { itemId: { in: initialAttachments === undefined ? allIds : [primary.id] } },
            select: { id: true, itemId: true, attachmentType: true },
          })
        : Promise.resolve(undefined),
    ]);

  const combinedAttachments = [
    ...(Array.isArray(initialAttachments) ? initialAttachments : []),
    ...(Array.isArray(queriedAttachments) ? queriedAttachments : []),
  ];
  const seenAttIds = new Set<string>();
  const dedupedAttachments = combinedAttachments.filter((a) => {
    if (!a?.id || seenAttIds.has(a.id)) return false;
    seenAttIds.add(a.id);
    return true;
  });

  const groupIds = (
    rows: Array<{ itemId?: string | null; id?: string }> | undefined,
    key: 'tagId' | 'collectionId' | 'id',
  ) => {
    const map = new Map<string, string[]>();
    for (const r of rows ?? []) {
      const val = (r as Record<string, unknown>)[key];
      if (r.itemId && typeof val === 'string') {
        const list = map.get(r.itemId) ?? [];
        list.push(val);
        map.set(r.itemId, list);
      }
    }
    return map;
  };

  const tagsByItem = groupIds(rawItemTags, 'tagId');
  const colsByItem = groupIds(rawCollectionItems, 'collectionId');
  const notesByItem = groupIds(queriedNotes, 'id');
  const attsByItem = groupIds(dedupedAttachments, 'id');
  const attRecordsByItem = new Map<string, MementoAttachmentRecord[]>();
  for (const row of dedupedAttachments) {
    if (row.itemId && row.id) {
      const list = attRecordsByItem.get(row.itemId) ?? [];
      list.push({
        id: row.id,
        ...(typeof (row as { attachmentType?: unknown }).attachmentType === 'string'
          ? { attachmentType: (row as { attachmentType: string }).attachmentType }
          : {}),
      });
      attRecordsByItem.set(row.itemId, list);
    }
  }

  const identsByItem = new Map<string, MementoIdentifierRecord[]>();
  for (const row of rawIdentifiers ?? []) {
    if (row.itemId && row.type && row.value) {
      const list = identsByItem.get(row.itemId) ?? [];
      list.push({ type: row.type, value: row.value, canonicalUri: row.canonicalUri ?? null });
      identsByItem.set(row.itemId, list);
    }
  }

  const contribsByItem = new Map<string, MementoContributorRecord[]>();
  for (const row of (rawContribs as Array<Record<string, unknown>> | undefined) ?? []) {
    const targetItemId = typeof row.itemId === 'string' ? row.itemId : primary.id;
    const list = contribsByItem.get(targetItemId) ?? [];
    const parsed = extractContributors([row]);
    if (parsed && parsed.length > 0) {
      list.push({ ...parsed[0], orderIndex: typeof row.orderIndex === 'number' ? row.orderIndex : list.length });
      contribsByItem.set(targetItemId, list);
    }
  }

  const statesByItem = new Map<string, MementoUserStateRecord[]>();
  for (const row of rawStates ?? []) {
    const targetItemId = typeof row.itemId === 'string' ? row.itemId : '';
    if (!targetItemId) continue;
    const parsed = extractUserStates([row]);
    if (parsed && parsed.length > 0) {
      const list = statesByItem.get(targetItemId) ?? [];
      list.push(parsed[0]);
      statesByItem.set(targetItemId, list);
    }
  }

  const primaryRelations: PreMergeItemRelations = {
    attachmentIds: attsByItem.get(primary.id) ?? asStringArray(primary.attachmentIds) ?? extractNestedIds(primary.attachments, 'id'),
    attachments: attRecordsByItem.get(primary.id) ?? extractAttachments(primary.attachments),
    noteIds: notesByItem.get(primary.id) ?? asStringArray(primary.noteIds) ?? extractNestedIds(primary.notesList, 'id'),
    tagIds: tagsByItem.get(primary.id) ?? asStringArray(primary.tagIds) ?? extractNestedIds(primary.itemTags, 'tagId'),
    collectionIds: colsByItem.get(primary.id) ?? asStringArray(primary.collectionIds) ?? extractNestedIds(primary.collectionItems, 'collectionId'),
    contributors: contribsByItem.get(primary.id) ?? extractContributors(primary.contributors),
    identifiers: identsByItem.get(primary.id) ?? extractIdentifiers(primary.identifiers),
    userStates: statesByItem.get(primary.id) ?? extractUserStates(primary.userStates ?? primary.states),
    itemRelations: extractItemRelations(primary.itemRelations),
    userPublications: extractUserPublications(primary.userPublications),
    itemMetadata: extractItemMetadata(primary.itemMetadata),
  };

  const duplicateRelationsById: Record<string, PreMergeItemRelations> = {};
  for (const dup of duplicates) {
    duplicateRelationsById[dup.id] = {
      attachmentIds: attsByItem.get(dup.id) ?? asStringArray(dup.attachmentIds) ?? extractNestedIds(dup.attachments, 'id'),
      attachments: attRecordsByItem.get(dup.id) ?? extractAttachments(dup.attachments),
      noteIds: notesByItem.get(dup.id) ?? asStringArray(dup.noteIds) ?? extractNestedIds(dup.notesList, 'id'),
      tagIds: tagsByItem.get(dup.id) ?? asStringArray(dup.tagIds) ?? extractNestedIds(dup.itemTags, 'tagId'),
      collectionIds: colsByItem.get(dup.id) ?? asStringArray(dup.collectionIds) ?? extractNestedIds(dup.collectionItems, 'collectionId'),
      identifiers: identsByItem.get(dup.id) ?? extractIdentifiers(dup.identifiers),
      contributors: contribsByItem.get(dup.id) ?? extractContributors(dup.contributors),
      userStates: statesByItem.get(dup.id) ?? extractUserStates(dup.userStates ?? dup.states),
      itemRelations: extractItemRelations(dup.itemRelations),
      userPublications: extractUserPublications(dup.userPublications),
      itemMetadata: extractItemMetadata(dup.itemMetadata),
    };
  }

  return { primaryRelations, duplicateRelationsById };
}

export function attachCapturedMergeStepRelations(params: {
  primaryId: string;
  duplicates: Array<{ id: string }>;
  primaryRelations: PreMergeItemRelations;
  duplicateRelationsById: Record<string, PreMergeItemRelations>;
  preMergeItemRelations?: Array<Record<string, unknown>>;
  preMergePubs?: {
    dupPublications: Array<Record<string, unknown>>;
    primaryPublications: Array<Record<string, unknown>>;
  };
  capturedPrimaryItemMetadata?: Array<Record<string, unknown>>;
  capturedDuplicateItemMetadata?: Array<Record<string, unknown>>;
}): void {
  const {
    primaryId,
    duplicates,
    primaryRelations,
    duplicateRelationsById,
    preMergeItemRelations,
    preMergePubs,
    capturedPrimaryItemMetadata,
    capturedDuplicateItemMetadata,
  } = params;

  if (Array.isArray(preMergeItemRelations) && preMergeItemRelations.length > 0) {
    primaryRelations.itemRelations = extractItemRelations(
      preMergeItemRelations.filter(
        (r) => r.sourceItemId === primaryId || r.targetItemId === primaryId,
      ),
    );
    for (const dup of duplicates) {
      const dupRels = extractItemRelations(
        preMergeItemRelations.filter(
          (r) => r.sourceItemId === dup.id || r.targetItemId === dup.id,
        ),
      );
      if (dupRels && dupRels.length > 0 && duplicateRelationsById[dup.id]) {
        duplicateRelationsById[dup.id].itemRelations = dupRels;
      }
    }
  }

  if (preMergePubs) {
    if (preMergePubs.primaryPublications.length > 0) {
      primaryRelations.userPublications = extractUserPublications(
        preMergePubs.primaryPublications,
      );
    } else if (primaryRelations.userPublications === undefined) {
      primaryRelations.userPublications = [];
    }
    for (const dup of duplicates) {
      const dupPubs = extractUserPublications(
        preMergePubs.dupPublications.filter((p) => !p.itemId || p.itemId === dup.id),
      );
      if (dupPubs && dupPubs.length > 0 && duplicateRelationsById[dup.id]) {
        duplicateRelationsById[dup.id].userPublications = dupPubs;
      }
    }
  }

  if (Array.isArray(capturedPrimaryItemMetadata)) {
    if (capturedPrimaryItemMetadata.length > 0) {
      primaryRelations.itemMetadata = extractItemMetadata(capturedPrimaryItemMetadata);
    } else if (primaryRelations.itemMetadata === undefined) {
      primaryRelations.itemMetadata = [];
    }
  }
  if (Array.isArray(capturedDuplicateItemMetadata) && capturedDuplicateItemMetadata.length > 0) {
    for (const dup of duplicates) {
      const dupMetas = extractItemMetadata(
        capturedDuplicateItemMetadata.filter((m) => !m.itemId || m.itemId === dup.id),
      );
      if (dupMetas && dupMetas.length > 0 && duplicateRelationsById[dup.id]) {
        duplicateRelationsById[dup.id].itemMetadata = dupMetas;
      }
    }
  }
}
