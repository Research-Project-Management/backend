import { getFileContentPath } from '@/modules/storage/storage.port';
import type { ItemDetail } from '@/modules/library/core/types/bibliographic.types';
import {
  ITEM_COLUMN_METADATA_FIELDS,
  TYPE_SPECIFIC_EXTRA_FIELDS,
} from '@/modules/library/catalog/types/catalog.types';
import {
  cleanCommentText,
  convertAcademicHtmlToMarkdown,
  normalizeAcademicTags,
  cleanSingleTag,
} from '@/modules/library/core';
import {
  MutableItemPayload,
  AttachmentLike,
  ItemIdentifierLike,
  parseJsonObject,
  mapCreatorsPartial,
  harmonizeDomainMetadataAndIdentifiersPartial,
  mapFlattenedStateHelper,
} from './item-bibliographic.mapper';

export {
  type MutableItemPayload,
  type AttachmentLike,
  type ItemIdentifierLike,
  parseJsonObject,
  mapCreatorsPartial,
  harmonizeDomainMetadataAndIdentifiersPartial,
  mapFlattenedStateHelper,
};

const NON_COLUMN_LOWER_SET = new Set(
  TYPE_SPECIFIC_EXTRA_FIELDS.map((f: string) => f.toLowerCase()),
);

const IGNORED_EXTRA_FIELD_PROMOTION_KEYS = new Set([
  'comment', 'comments', 'notes', 'provenance', '_rawExtra', 'DOI', 'ISBN',
  'ISSN', 'PMID', 'PMCID', 'archiveID', 'journalAbbr', 'accessedAt',
  'citeKey', 'labels', 'keywordsList',
]);

function escapeHtmlText(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function unpackMetadataAndExtraPartial(it: MutableItemPayload): void {
  const metaObj = parseJsonObject(it.metadata);
  const hasRelationalItemTags = Array.isArray(it.itemTags);
  const hasRelationalPublications = Array.isArray(it.publications);
  const rawMetaExtraFields =
    metaObj &&
    metaObj.extraFields &&
    typeof metaObj.extraFields === 'object' &&
    !Array.isArray(metaObj.extraFields)
      ? (metaObj.extraFields as Record<string, unknown>)
      : null;
  if (metaObj) {
    for (const [key, value] of Object.entries(metaObj)) {
      if (key === 'extraFields' || key === 'metadata') {
        continue;
      }
      if (hasRelationalPublications && key === 'isMyPublication') {
        continue;
      }
      if (
        hasRelationalItemTags &&
        (key === 'tags' ||
          key === 'keywords' ||
          key === 'zoteroTags' ||
          key === 'labels' ||
          key === 'keywordsList')
      ) {
        continue;
      }
      if (
        value !== undefined &&
        value !== null &&
        value !== '' &&
        (it[key] === undefined || it[key] === null || it[key] === '')
      ) {
        it[key] = value;
      }
    }
  }

  it.itemType = it.itemType || it.type || 'journalArticle';
  it.type = it.type || it.itemType || 'journalArticle';

  let extraFields: Record<string, unknown> = {};
  const unmappedRetainedLowerSet = new Set<string>();
  const collectUnmappedKeys = (obj?: Record<string, unknown> | null) => {
    if (!obj || typeof obj !== 'object') return;
    for (const k of Object.keys(obj)) {
      if (k.startsWith('__unmapped_')) {
        const rest = k.slice('__unmapped_'.length);
        const underscoreIdx = rest.indexOf('_');
        const fieldName =
          underscoreIdx >= 0 ? rest.slice(underscoreIdx + 1) : rest;
        if (fieldName) {
          const lower = fieldName.toLowerCase();
          unmappedRetainedLowerSet.add(lower);
          unmappedRetainedLowerSet.add(lower.replace(/[\s_-]+/g, ''));
        }
      }
    }
  };
  collectUnmappedKeys(metaObj);
  collectUnmappedKeys(rawMetaExtraFields);
  collectUnmappedKeys(
    it.extraFields && typeof it.extraFields === 'object' ? it.extraFields : null,
  );

  if (it.extraFields && typeof it.extraFields === 'object') {
    extraFields = {
      ...(rawMetaExtraFields || {}),
      ...it.extraFields,
    };
  } else {
    if (rawMetaExtraFields) {
      extraFields = { ...rawMetaExtraFields };
    }
    const parsedExtraJson = parseJsonObject(it.extra);
    if (parsedExtraJson) {
      extraFields = { ...extraFields, ...parsedExtraJson };
    } else if (typeof it.extra === 'string' && it.extra.trim()) {
      const remainingLines: string[] = [];
      for (const line of it.extra.split(/\r?\n/)) {
        const match = line.match(
          /^\s*([a-zA-Z_][a-zA-Z0-9_.\s-]{0,40}):\s*(.+)$/,
        );
        if (!match) {
          remainingLines.push(line);
          continue;
        }
        const rawKey = match[1].trim();
        const val = match[2].trim();
        const camelKey = rawKey
          .replace(/[\s_-]+([a-zA-Z0-9])/g, (_: string, c: string) =>
            c.toUpperCase(),
          )
          .replace(/^[A-Z]/, (c: string) => c.toLowerCase());
        const lowerKey = camelKey.toLowerCase();
        const rawLower = rawKey.toLowerCase();
        const compactKey = rawLower.replace(/[\s_-]+/g, '');

        if (
          unmappedRetainedLowerSet.has(lowerKey) ||
          unmappedRetainedLowerSet.has(rawLower) ||
          unmappedRetainedLowerSet.has(compactKey)
        ) {
          remainingLines.push(line);
        } else if (/^citations?(\s*count)?$/i.test(rawKey)) {
          const num = parseInt(val.replace(/,/g, ''), 10);
          if (!isNaN(num)) extraFields.citationCount = num;
        } else if (/^comments?$/i.test(rawKey)) {
          const cleaned = cleanCommentText(val);
          if (cleaned) extraFields.comment = cleaned;
        } else if (/^(numPages|numberOfPages|pageCount)$/i.test(camelKey)) {
          const num = parseInt(val, 10);
          const resolvedNum = isNaN(num) ? val : num;
          extraFields[camelKey] = resolvedNum;
          extraFields.numPages = resolvedNum;
          extraFields.numberOfPages = resolvedNum;
        } else if (
          NON_COLUMN_LOWER_SET.has(lowerKey) ||
          ITEM_COLUMN_METADATA_FIELDS.has(camelKey)
        ) {
          extraFields[camelKey] = /^(true|false)$/i.test(val)
            ? val.toLowerCase() === 'true'
            : /^\d+$/.test(val)
              ? parseInt(val, 10)
              : val;
        } else {
          remainingLines.push(line);
        }
      }
      it.extra = remainingLines.join('\n');
    }
  }

  if (typeof extraFields._rawExtra === 'string') {
    it.extra = extraFields._rawExtra;
    delete extraFields._rawExtra;
  } else if (typeof it.extra === 'string' && it.extra.trim().startsWith('{')) {
    it.extra = '';
  }
  it.extraFields = extraFields;

  for (const [k, v] of Object.entries(extraFields)) {
    if (
      v !== undefined &&
      v !== null &&
      v !== '' &&
      (it[k] === undefined || it[k] === null || it[k] === '') &&
      !IGNORED_EXTRA_FIELD_PROMOTION_KEYS.has(k)
    ) {
      it[k] = v;
    }
  }
}

export function inferViewerFormat(
  att?: {
    attachmentType?: string | null;
    mimeType?: string | null;
    filename?: string | null;
  } | null,
): 'pdf' | 'epub' | 'snapshot' {
  const mime = (att?.mimeType || '').toLowerCase();
  const filename = (att?.filename || '').toLowerCase();
  const attType = (att?.attachmentType || '').toLowerCase();

  if (mime.includes('epub') || filename.endsWith('.epub')) {
    return 'epub';
  }
  if (
    attType === 'snapshot' ||
    mime.includes('html') ||
    filename.endsWith('.html') ||
    filename.endsWith('.htm')
  ) {
    return 'snapshot';
  }
  return 'pdf';
}

export function mapAttachmentsAndPrimaryFilePartial(
  it: MutableItemPayload,
): AttachmentLike | null {
  if (Array.isArray(it.attachments)) {
    it.attachments = it.attachments.map((attachment) => {
      if (!attachment || typeof attachment !== 'object') return attachment;
      const normalized: AttachmentLike = { ...attachment };
      const attMeta = parseJsonObject(normalized.metadata) || {};
      normalized.title =
        normalized.title ||
        (attMeta.title as string | undefined) ||
        normalized.filename ||
        '';
      if (normalized.id) {
        (normalized as Record<string, unknown>).attachmentId = normalized.id;
      }
      (normalized as Record<string, unknown>).viewerFormat =
        inferViewerFormat(normalized);
      if (normalized.size !== undefined && normalized.size !== null) {
        normalized.size = Number(normalized.size);
        (normalized as Record<string, unknown>).fileSize = normalized.size;
      }
      if (Array.isArray(normalized.revisions)) {
        normalized.revisions = normalized.revisions.map((rev) => ({
          ...rev,
          ...(rev?.sizeBytes !== undefined && rev?.sizeBytes !== null
            ? { sizeBytes: Number(rev.sizeBytes) }
            : {}),
          ...(rev?.fileId
            ? { url: getFileContentPath(String(rev.fileId)) }
            : normalized.fileId
              ? { url: getFileContentPath(normalized.fileId) }
              : {}),
        }));
      }
      if (normalized.fileId) {
        normalized.url = getFileContentPath(normalized.fileId);
      }
      return normalized;
    });
  }

  let primaryPdf: AttachmentLike | null = null;
  if (Array.isArray(it.attachments) && it.attachments.length > 0) {
    const atts = it.attachments;
    primaryPdf =
      atts.find((a) => a?.attachmentType === 'primary_pdf' && a?.fileId) ||
      atts.find((a) => a?.mimeType === 'application/pdf' && a?.fileId) ||
      atts.find((a) =>
        Boolean(
          a?.fileId &&
          typeof a?.filename === 'string' &&
          a.filename.toLowerCase().endsWith('.pdf'),
        ),
      ) ||
      null;
  }

  if (
    !it.openAccessPdfUrl &&
    typeof it.fileUrl === 'string' &&
    /^https?:\/\//i.test(it.fileUrl)
  ) {
    it.openAccessPdfUrl = it.fileUrl;
  }

  if (primaryPdf?.fileId) {
    it.fileUrl = getFileContentPath(primaryPdf.fileId);
  } else if (
    typeof it.fileUrl === 'string' &&
    it.fileUrl.startsWith('/api/v1/storage/files/') &&
    !it.fileUrl.includes('/r2/') &&
    !it.fileUrl.endsWith('/content')
  ) {
    const match = it.fileUrl.match(/^\/api\/v1\/storage\/files\/([^/?#]+)$/);
    if (match?.[1]) {
      it.fileUrl = getFileContentPath(match[1]);
    }
  } else if (
    typeof it.fileUrl === 'string' &&
    !it.fileUrl.endsWith('/content') &&
    !it.fileUrl.startsWith('/api/v1/storage/files/')
  ) {
    const isPdfLink =
      /\.pdf(?:[?#]|$)/i.test(it.fileUrl) ||
      /\/pdf\//i.test(it.fileUrl) ||
      Boolean(it.openAccessPdfUrl && it.fileUrl === it.openAccessPdfUrl);
    if (!isPdfLink) {
      it.fileUrl = it.openAccessPdfUrl || null;
    }
  } else if (!it.fileUrl) {
    it.fileUrl = it.openAccessPdfUrl || null;
  }

  return primaryPdf;
}

export function finalizePrimaryFilePartial(
  it: MutableItemPayload,
  primaryPdf: AttachmentLike | null,
): void {
  if (primaryPdf) {
    it.filename = it.filename || primaryPdf.filename || '';
    it.mimeType = it.mimeType || primaryPdf.mimeType || 'application/pdf';
    it.size = it.size || primaryPdf.size || 0;
  }

  if (primaryPdf?.fileId) {
    it.primaryFile = {
      attachmentId: primaryPdf.id ?? null,
      fileId: primaryPdf.fileId,
      filename: it.filename || primaryPdf.filename || '',
      title:
        primaryPdf.title ||
        (primaryPdf.metadata?.title as string | undefined) ||
        it.filename ||
        primaryPdf.filename ||
        '',
      url: it.fileUrl || '',
      size: it.size || primaryPdf.size || 0,
      mimeType: it.mimeType || primaryPdf.mimeType || 'application/pdf',
      viewerFormat: inferViewerFormat(primaryPdf),
    };
  } else if (it.fileUrl) {
    it.primaryFile = {
      attachmentId: primaryPdf?.id ?? null,
      fileId: null,
      filename: it.filename || '',
      title: it.filename || '',
      url: it.fileUrl,
      size: it.size || 0,
      mimeType: it.mimeType || 'application/pdf',
      viewerFormat: inferViewerFormat({
        mimeType: it.mimeType,
        filename: it.filename,
      }),
    };
  } else {
    it.primaryFile = it.primaryFile ?? null;
  }
}

const PRISMA_TO_DTO_RELATION: Record<string, string> = {
  CITES: 'cites', CITED_BY: 'isCitedBy', SUPPLEMENT_TO: 'supplementTo',
  SUPPLEMENTED_BY: 'isSupplementedBy', RELATED: 'related', CONTINUES: 'continues',
  CONTINUED_BY: 'isContinuedBy', PART_OF: 'partOf',
};

export function mapPublicationsAndRelationsPartial(
  it: MutableItemPayload,
  toDomainFn: <T>(item: T) => T,
): void {
  const metaObj = parseJsonObject(it.metadata);
  if (Array.isArray(it.publications)) {
    it.isMyPublication = it.publications.length > 0;
  } else if (it.isMyPublication === undefined) {
    it.isMyPublication = Boolean(metaObj?.isMyPublication);
  } else {
    it.isMyPublication = Boolean(it.isMyPublication);
  }

  const combinedRelations: Array<Record<string, unknown>> = [];
  if (Array.isArray(it.outgoingRel)) {
    for (const rel of it.outgoingRel) {
      const peer = rel.targetItem ?? rel.toItem;
      const rawRelType = typeof rel.relationType === 'string' ? rel.relationType : 'related';
      combinedRelations.push({
        id: rel.id,
        targetItemId: rel.targetItemId ?? rel.toItemId,
        relationType: PRISMA_TO_DTO_RELATION[rawRelType] ?? rawRelType,
        direction: 'outgoing',
        description: rel.description || '',
        linkedAt: rel.createdAt,
        targetItem: peer ? toDomainFn(peer) : undefined,
      });
    }
  }
  if (Array.isArray(it.incomingRel)) {
    for (const rel of it.incomingRel) {
      const peer = rel.sourceItem ?? rel.fromItem;
      const rawRelType = typeof rel.relationType === 'string' ? rel.relationType : 'related';
      combinedRelations.push({
        id: rel.id,
        targetItemId: rel.sourceItemId ?? rel.fromItemId,
        relationType: PRISMA_TO_DTO_RELATION[rawRelType] ?? rawRelType,
        direction: 'incoming',
        description: rel.description || '',
        linkedAt: rel.createdAt,
        targetItem: peer ? toDomainFn(peer) : undefined,
      });
    }
  }

  if (combinedRelations.length === 0 && metaObj?.relations) {
    const metaRels = metaObj.relations;
    if (Array.isArray(metaRels)) {
      combinedRelations.push(...(metaRels as Array<Record<string, unknown>>));
    } else if (typeof metaRels === 'object' && metaRels !== null) {
      const metaRelObj = metaRels as Record<string, unknown>;
      const pushRdfUris = (
        rawUris: unknown,
        relationType: string,
        sameAs?: boolean,
      ) => {
        const list = Array.isArray(rawUris)
          ? rawUris
          : typeof rawUris === 'string' && rawUris
            ? [rawUris]
            : [];
        for (const uri of list) {
          combinedRelations.push({
            uri,
            relationType,
            direction: 'outgoing',
            ...(sameAs ? { sameAs: true } : {}),
          });
        }
      };
      pushRdfUris(metaRelObj['dc:relation'], 'related');
      pushRdfUris(metaRelObj['owl:sameAs'], 'is_published_version_of', true);
    }
  }
  it.relations = combinedRelations;

  if (!it.seeAlso && metaObj?.seeAlso) {
    it.seeAlso = metaObj.seeAlso;
  } else if (!it.seeAlso && combinedRelations.length > 0) {
    it.seeAlso = combinedRelations
      .map(
        (r) =>
          (r.targetItemId as string | undefined) ||
          (r.uri as string | undefined),
      )
      .filter(Boolean);
  }
}

export function mapTagsCollectionsNotesPartial(it: MutableItemPayload): void {
  if (Array.isArray(it.states) && it.states.length > 0) {
    const active = it.states[0];
    if (it.isStarred === undefined && active?.isStarred !== undefined) {
      it.isStarred = Boolean(active.isStarred);
    }
    if (
      it.readStatus === undefined &&
      typeof active?.readStatus === 'string' &&
      active.readStatus
    ) {
      it.readStatus = active.readStatus;
    }
    if (it.rating === undefined && typeof active?.rating === 'number') {
      it.rating = active.rating;
    }
    if (it.currentPage === undefined) it.currentPage = typeof active?.currentPage === 'number' ? active.currentPage : null;
    if (it.lastReadPage === undefined) it.lastReadPage = typeof active?.currentPage === 'number' ? active.currentPage : null;
    if (it.scrollPosition === undefined) it.scrollPosition = active?.scrollPosition ?? null;
    if (it.lastOpenedAt === undefined) {
      it.lastOpenedAt = active?.lastOpenedAt ? (active.lastOpenedAt instanceof Date ? active.lastOpenedAt.toISOString() : String(active.lastOpenedAt)) : null;
    }
    if (!it.lastReadAt) {
      const stateWithReadAt = it.states.find((u) => u?.lastReadAt);
      if (stateWithReadAt?.lastReadAt) {
        it.lastReadAt =
          stateWithReadAt.lastReadAt instanceof Date
            ? stateWithReadAt.lastReadAt.toISOString()
            : (stateWithReadAt.lastReadAt as string);
      }
    }
  }

  const buildZoteroTags = (
    items: unknown[],
    extractEntry: (entry: unknown) => { rawName: string; isAuto: boolean },
  ) => {
    const seen = new Set<string>();
    return items
      .map((entry) => {
        const { rawName, isAuto } = extractEntry(entry);
        const cleanedName = cleanSingleTag(rawName);
        if (!cleanedName) return null;
        const lower = cleanedName.toLowerCase();
        if (seen.has(lower)) return null;
        seen.add(lower);
        return { tag: cleanedName, type: isAuto ? 1 : 0 };
      })
      .filter((zt): zt is NonNullable<typeof zt> => Boolean(zt));
  };

  if (Array.isArray(it.itemTags)) {
    const itemTagArr = it.itemTags;
    if (itemTagArr.length > 0) {
      const rawTagNames = itemTagArr
        .map(
          (t) =>
            (t.tag as { name?: string } | undefined)?.name ||
            (t.name as string | undefined),
        )
        .filter(Boolean) as string[];
      const tagNames = normalizeAcademicTags(rawTagNames);
      it.tags = tagNames;
      it.keywords = tagNames;
      it.zoteroTags = buildZoteroTags(itemTagArr, (entry) => {
        const t = entry as Record<string, unknown>;
        const tagObj = t.tag as { name?: string; type?: unknown } | undefined;
        return {
          rawName: tagObj?.name || (t.name as string | undefined) || '',
          isAuto:
            t.type === 'automatic' ||
            t.type === 1 ||
            (!t.type && tagObj?.type === 'automatic'),
        };
      });
    } else if (Array.isArray(it.tags) && it.tags.length > 0) {
      const rawTags = it.tags;
      const tagNames = normalizeAcademicTags(rawTags as string[]);
      it.tags = tagNames;
      it.keywords = tagNames;
      it.zoteroTags = buildZoteroTags(rawTags, (t) => {
        const tObj =
          typeof t === 'object' && t !== null
            ? (t as Record<string, unknown>)
            : null;
        const rawName =
          typeof t === 'string'
            ? t
            : (tObj?.tag as string) || (tObj?.name as string) || '';
        const isAuto = tObj?.type === 1 || tObj?.type === 'automatic';
        return { rawName, isAuto };
      });
    } else {
      it.tags = [];
      it.keywords = [];
      it.zoteroTags = [];
    }
  } else {
    const metaObj = parseJsonObject(it.metadata) || {};
    const firstNonEmptyArray = (candidates: unknown[]): unknown[] => {
      for (const c of candidates) {
        if (Array.isArray(c) && c.length > 0) return c;
      }
      return [];
    };
    const rawTags = firstNonEmptyArray([
      it.tags,
      it.keywords,
      it.labels,
      it.keywordsList,
      metaObj.tags,
      metaObj.keywords,
      metaObj.labels,
      metaObj.keywordsList,
    ]);
    const tagNames = normalizeAcademicTags(rawTags as string[]);
    it.tags = tagNames;
    it.keywords = tagNames;
    it.zoteroTags = buildZoteroTags(rawTags, (t) => {
      const tObj =
        typeof t === 'object' && t !== null
          ? (t as Record<string, unknown>)
          : null;
      const rawName =
        typeof t === 'string'
          ? t
          : (tObj?.tag as string) || (tObj?.name as string) || '';
      const isAuto = tObj?.type === 1 || tObj?.type === 'automatic';
      return { rawName, isAuto };
    });
  }
  delete it.labels;
  delete it.keywordsList;

  if (Array.isArray(it.collectionItems) && it.collectionItems.length > 0) {
    const colItems = it.collectionItems;
    const firstCol = colItems[0].collection as { id?: string } | undefined;
    it.collectionId =
      it.collectionId ||
      (colItems[0].collectionId as string | undefined) ||
      firstCol?.id ||
      null;
    it.collectionIds = colItems
      .map(
        (ci) =>
          (ci.collectionId as string | undefined) ||
          (ci.collection as { id?: string } | undefined)?.id,
      )
      .filter(Boolean) as string[];
    it.collections = colItems.map((ci) => ci.collection).filter(Boolean);
  } else {
    it.collectionId = it.collectionId || null;
    it.collectionIds = it.collectionIds || [];
    it.collections = it.collections || [];
  }

  const cleanNoteBody = convertAcademicHtmlToMarkdown;

  const normalizeNoteList = (list: Array<Record<string, unknown>>) => {
    const seen = new Set<string>();
    return list
      .map((n) => {
        const rawText = (n.contentMd || n.content || n.note || '') as string;
        const text = cleanNoteBody(rawText);
        if (!text) return null;
        const noteId =
          typeof n.id === 'string' && n.id.trim().length > 0
            ? n.id.trim()
            : null;
        const dedupeKey = noteId
          ? `id:${noteId}`
          : `text:${text.toLowerCase()}`;
        if (seen.has(dedupeKey)) return null;
        seen.add(dedupeKey);
        return {
          ...n,
          content: text,
          contentMd: text,
          note:
            typeof n.note === 'string' && n.note
              ? n.note
              : `<p>${escapeHtmlText(text)}</p>`,
          itemType: 'note',
        };
      })
      .filter((n): n is NonNullable<typeof n> => n !== null);
  };

  if (Array.isArray(it.notesList) && it.notesList.length > 0) {
    it.notes = normalizeNoteList(it.notesList);
  } else if (Array.isArray(it.notes) && it.notes.length > 0) {
    it.notes = normalizeNoteList(it.notes);
  } else if (it.extraFields && typeof it.extraFields.comment === 'string') {
    const commentVal = cleanCommentText(it.extraFields.comment);
    if (commentVal) {
      const formatted = commentVal.toLowerCase().startsWith('comment:')
        ? commentVal
        : `Comment: ${commentVal}`;
      it.notes = [
        {
          id: `comment-${it.id}`,
          content: formatted,
          contentMd: formatted,
          note: `<p>${escapeHtmlText(formatted)}</p>`,
          itemType: 'note',
          source: 'arXiv',
          createdAt: it.createdAt || new Date().toISOString(),
          updatedAt: it.updatedAt || new Date().toISOString(),
        },
      ];
    } else {
      it.notes = [];
    }
  } else {
    it.notes = [];
  }

  delete it.notesList;
  if (it.extraFields && 'comment' in it.extraFields) {
    delete it.extraFields.comment;
  }
}

export class ItemsMapper {
  static toDomain<T = Record<string, unknown>>(
    raw: T,
    visitedOrUserId: WeakSet<object> | string = new WeakSet(),
  ): T & Partial<ItemDetail> {
    if (!raw || typeof raw !== 'object') return raw as T & Partial<ItemDetail>;
    const visited =
      visitedOrUserId instanceof WeakSet ? visitedOrUserId : new WeakSet<object>();
    const userId =
      typeof visitedOrUserId === 'string' && visitedOrUserId
        ? visitedOrUserId
        : undefined;
    if (visited.has(raw as object)) {
      return { ...(raw as Record<string, unknown>) } as unknown as T & Partial<ItemDetail>;
    }
    visited.add(raw as object);
    const it = { ...(raw as Record<string, unknown>) } as MutableItemPayload;
    if (userId && Array.isArray(it.states) && it.states.length > 1) {
      const matchedState = it.states.find(
        (s) => !s?.userId || s.userId === userId,
      );
      if (matchedState) {
        it.states = [matchedState];
      }
    }
    unpackMetadataAndExtraPartial(it);
    const primaryPdf = mapAttachmentsAndPrimaryFilePartial(it);
    mapCreatorsPartial(it);
    mapTagsCollectionsNotesPartial(it);
    harmonizeDomainMetadataAndIdentifiersPartial(it);
    finalizePrimaryFilePartial(it, primaryPdf);
    mapPublicationsAndRelationsPartial(it, (target) => ItemsMapper.toDomain(target, visited));
    return it as unknown as T & Partial<ItemDetail>;
  }

  static toDomainList<T = Record<string, unknown>>(items: T[]): Array<T & Partial<ItemDetail>> {
    if (!Array.isArray(items)) return [];
    return items.map((item) => this.toDomain(item));
  }

  static mapFlattenedState<T extends Record<string, unknown>>(
    item: T | null | undefined,
    userId?: string,
  ): (T & { readStatus: string; rating: number; lastReadAt: string | null }) | null {
    return mapFlattenedStateHelper(item, (it) => ItemsMapper.toDomain(it), userId);
  }
}
