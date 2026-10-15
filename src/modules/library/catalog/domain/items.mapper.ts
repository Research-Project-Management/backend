import { getFileContentPath } from '@/modules/storage/storage.port';
import {
  ITEM_COLUMN_METADATA_FIELDS,
  TYPE_SPECIFIC_EXTRA_FIELDS,
} from '@/modules/library/catalog/types/items.constants';
import {
  cleanAbstractText,
  cleanCommentText,
  splitAuthorString,
} from '@/modules/library/shared-kernel/domain/bibliographic.domain';
import {
  resolveCanonicalArxivCategory,
  normalizeTags,
  cleanSingleTag,
} from '@/modules/library/shared-kernel/domain/tag.domain';
import {
  getEffectiveBaseFieldMap,
  resolveBidirectionalBaseFields,
  resolveCanonicalCreatorRole,
  resolveFieldAliases,
} from '@/modules/library/shared-kernel/domain/zotero-field-harmonizer.domain';
import type { CreatorCreditInput } from '@/modules/library/catalog/types/items.types';

export interface AttachmentLike {
  attachmentType?: string;
  mimeType?: string;
  filename?: string;
  fileId?: string | null;
  title?: string;
  metadata?: { title?: string; [key: string]: unknown } | null;
  url?: string;
  revisions?: Array<{ url?: string; [key: string]: unknown }>;
  size?: number;
  [key: string]: unknown;
}

export interface ItemIdentifierLike {
  type?: string;
  identifierType?: string;
  value?: string;
  canonicalUri?: string | null;
  [key: string]: unknown;
}

export type MutableItemPayload = Record<string, unknown> & {
  id?: string;
  createdAt?: string;
  updatedAt?: string;
  attachments?: AttachmentLike[];
  userStates?: Array<Record<string, unknown>>;
  states?: Array<Record<string, unknown>>;
  metadata?: Record<string, unknown> | string | null;
  contributors?: CreatorCreditInput[];
  creators?: CreatorCreditInput[];
  authors?: string[] | unknown;
  editors?: string[] | unknown;
  itemTags?: Array<Record<string, unknown>>;
  tags?: unknown;
  labels?: unknown;
  keywords?: unknown;
  zoteroTags?: unknown;
  collectionItems?: Array<Record<string, unknown>>;
  collectionId?: string | null;
  collectionIds?: string[];
  collections?: unknown[];
  notesList?: Array<Record<string, unknown>>;
  notes?: Array<Record<string, unknown>>;
  extraFields?: Record<string, unknown>;
  extra?: string | unknown;
  citationCount?: number | string | null;
  referenceCount?: number | string | null;
  openAccessPdfUrl?: string | null;
  doi?: string | null;
  DOI?: string | null;
  arxivId?: string | null;
  archiveId?: string | null;
  archiveID?: string | null;
  isbn?: string | null;
  ISBN?: string | null;
  issn?: string | null;
  ISSN?: string | null;
  pmid?: string | null;
  PMID?: string | null;
  pmcid?: string | null;
  PMCID?: string | null;
  identifiers?: ItemIdentifierLike[];
  seriesNumber?: string | null;
  edition?: string | null;
  numPages?: number | string | null;
  numberOfPages?: number | string | null;
  proceedingsTitle?: string | null;
  conferenceName?: string | null;
  institution?: string | null;
  university?: string | null;
  reportNumber?: string | null;
  reportType?: string | null;
  thesisType?: string | null;
  repository?: string | null;
  country?: string | null;
  websiteTitle?: string | null;
  websiteType?: string | null;
  blogTitle?: string | null;
  issuingAuthority?: string | null;
  authority?: string | null;
  patentNumber?: string | null;
  issueDate?: string | null;
  priorityDate?: string | null;
  originalDate?: string | null;
  assignee?: string | null;
  rights?: string | null;
  license?: string | null;
  abstract?: string | null;
  abstractNote?: string | null;
  year?: number | string | null;
  date?: string | null;
  publicationDate?: string | null;
  publicationTitle?: string | null;
  journal?: string | null;
  journalAbbreviation?: string | null;
  journalAbbr?: string | null;
  place?: string | null;
  eventPlace?: string | null;
  bookTitle?: string | null;
  volume?: string | null;
  issue?: string | null;
  pages?: string | null;
  callNumber?: string | null;
  accessDate?: string | null;
  accessedAt?: string | Date | null;
  citationKey?: string | null;
  citeKey?: string | null;
  genre?: string | null;
  number?: string | null;
  isStarred?: boolean;
  readStatus?: string;
  rating?: number;
  lastReadAt?: string | Date | null;
  itemType?: string;
  type?: string;
  fileUrl?: string | null;
  filename?: string;
  mimeType?: string;
  size?: number;
  primaryFile?: Record<string, unknown> | null;
  isMyPublication?: boolean;
  publications?: unknown[];
  outgoingRel?: Array<Record<string, unknown>>;
  incomingRel?: Array<Record<string, unknown>>;
  relations?: unknown[];
  seeAlso?: unknown;
  [key: string]: unknown;
};

const NON_COLUMN_LOWER_SET = new Set(
  TYPE_SPECIFIC_EXTRA_FIELDS.map((f: string) => f.toLowerCase()),
);

const IGNORED_EXTRA_FIELD_PROMOTION_KEYS = new Set([
  'comment',
  'comments',
  'notes',
  'provenance',
  '_rawExtra',
]);

function parseJsonObject(val: unknown): Record<string, unknown> | null {
  if (val && typeof val === 'object' && !Array.isArray(val)) {
    return val as Record<string, unknown>;
  }
  if (typeof val === 'string' && val.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(val.trim());
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Partial 1: Unpacks PostgreSQL JsonB `metadata` and `extra` / `extraFields`
 * into top-level domain properties and normalized `extraFields`.
 */
function unpackMetadataAndExtraPartial(it: MutableItemPayload): void {
  const metaObj = parseJsonObject(it.metadata);
  if (metaObj) {
    for (const [key, value] of Object.entries(metaObj)) {
      if (value !== undefined && value !== null && it[key] === undefined) {
        it[key] = value;
      }
    }
  }

  it.itemType = it.itemType || it.type || 'journalArticle';
  it.type = it.type || it.itemType || 'journalArticle';

  let extraFields: Record<string, unknown> = {};
  if (it.extraFields && typeof it.extraFields === 'object') {
    extraFields = { ...it.extraFields };
  } else {
    const parsedExtraJson = parseJsonObject(it.extra);
    if (parsedExtraJson) {
      extraFields = { ...parsedExtraJson };
    } else if (typeof it.extra === 'string' && it.extra.trim()) {
      const remainingLines: string[] = [];
      for (const line of it.extra.split(/\r?\n/)) {
        const match = line.match(/^([a-zA-Z0-9_\s]+):\s*(.+)$/);
        if (!match) {
          remainingLines.push(line);
          continue;
        }
        const rawKey = match[1].trim();
        const val = match[2].trim();
        const camelKey = rawKey
          .replace(/\s+([a-zA-Z])/g, (_: string, c: string) => c.toUpperCase())
          .replace(/^[A-Z]/, (c: string) => c.toLowerCase());
        const lowerKey = camelKey.toLowerCase();

        if (/^citations?(\s*count)?$/i.test(rawKey)) {
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
      it[k] === undefined &&
      !IGNORED_EXTRA_FIELD_PROMOTION_KEYS.has(k)
    ) {
      it[k] = v;
    }
  }
}

/**
 * Partial 2: Normalizes attachments, resolves primary PDF priority,
 * and constructs `fileUrl` and `primaryFile`.
 */
function mapAttachmentsAndPrimaryFilePartial(
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
      if (normalized.fileId) {
        const canonicalUrl = getFileContentPath(normalized.fileId);
        normalized.url = canonicalUrl;
        if (Array.isArray(normalized.revisions)) {
          normalized.revisions = normalized.revisions.map((rev) => ({
            ...rev,
            url: canonicalUrl,
          }));
        }
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
    it.fileUrl.startsWith('/api/files/') &&
    !it.fileUrl.includes('/r2/') &&
    !it.fileUrl.endsWith('/content')
  ) {
    const match = it.fileUrl.match(/^\/api\/files\/([^/?#]+)$/);
    if (match?.[1]) {
      it.fileUrl = getFileContentPath(match[1]);
    }
  } else if (
    typeof it.fileUrl === 'string' &&
    !it.fileUrl.endsWith('/content') &&
    !it.fileUrl.startsWith('/api/files/')
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

function finalizePrimaryFilePartial(
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
      fileId: primaryPdf.fileId,
      filename: it.filename || primaryPdf.filename || '',
      title:
        primaryPdf.title ||
        primaryPdf.metadata?.title ||
        it.filename ||
        primaryPdf.filename ||
        '',
      url: it.fileUrl || '',
      size: it.size || primaryPdf.size || 0,
      mimeType: it.mimeType || primaryPdf.mimeType || 'application/pdf',
    };
  } else if (it.fileUrl) {
    it.primaryFile = {
      fileId: null,
      filename: it.filename || '',
      title: it.filename || '',
      url: it.fileUrl,
      size: it.size || 0,
      mimeType: it.mimeType || 'application/pdf',
    };
  } else {
    it.primaryFile = it.primaryFile ?? null;
  }
}

/**
 * Partial 3: Normalizes creators, authors, and editors.
 */
function mapCreatorsPartial(it: MutableItemPayload): void {
  const rawStructured =
    Array.isArray(it.contributors) && it.contributors.length > 0
      ? it.contributors
      : Array.isArray(it.creators) && it.creators.length > 0
        ? it.creators
        : null;

  if (rawStructured) {
    it.creators = rawStructured.map((c: CreatorCreditInput, idx: number) => {
      const full =
        c.fullName ||
        [c.firstName, c.lastName].filter(Boolean).join(' ') ||
        c.name ||
        '';
      return {
        id: (c as { id?: string }).id,
        orderIndex: c.orderIndex ?? idx,
        creatorType: resolveCanonicalCreatorRole(c.creatorType, {
          itemType: it.itemType,
        }),
        fieldMode: (c as { fieldMode?: number }).fieldMode ?? 0,
        firstName: c.firstName || undefined,
        lastName: c.lastName || undefined,
        shortName: (c as { shortName?: string }).shortName || undefined,
        fullName: full,
        name: full,
      };
    });
  } else if (Array.isArray(it.authors) && it.authors.length > 0) {
    it.creators = (it.authors as string[]).map((name: string, idx: number) => ({
      orderIndex: idx,
      creatorType: 'author',
      fullName: name,
      name,
    }));
  } else {
    it.creators = [];
  }

  if (Array.isArray(it.creators) && it.creators.length > 0) {
    const authorCreators = it.creators.filter(
      (c: CreatorCreditInput) => (c.creatorType || 'author') === 'author',
    );
    it.authors = (authorCreators.length > 0 ? authorCreators : it.creators)
      .map(
        (c: CreatorCreditInput) =>
          c.fullName ||
          c.name ||
          [c.firstName, c.lastName].filter(Boolean).join(' '),
      )
      .filter(Boolean);
  } else if (Array.isArray(it.authors) && it.authors.length > 0) {
    it.authors = (it.authors as string[]).flatMap((a: string) =>
      splitAuthorString(a),
    );
  } else {
    it.authors = [];
  }

  it.editors = (it.creators || [])
    .filter((c: CreatorCreditInput) => c.creatorType === 'editor')
    .map((c: CreatorCreditInput) => c.fullName || c.name || '')
    .filter(Boolean);
}

/**
 * Partial 4: Projects tags, collections, notes, user states, and relations.
 */
function mapTagsCollectionsNotesPartial(it: MutableItemPayload): void {
  // User States
  if (!it.userStates && Array.isArray(it.states)) {
    it.userStates = it.states;
  }
  if (Array.isArray(it.userStates) && it.userStates.length > 0) {
    const active = it.userStates[0];
    if (it.isStarred === undefined && active?.isStarred !== undefined) {
      it.isStarred = Boolean(active.isStarred);
    }
    if (it.readStatus === undefined && active?.readStatus) {
      it.readStatus = String(active.readStatus);
    }
    if (it.rating === undefined && typeof active?.rating === 'number') {
      it.rating = active.rating;
    }
    if (!it.lastReadAt) {
      const stateWithReadAt = it.userStates.find((u) => u?.lastReadAt);
      if (stateWithReadAt?.lastReadAt) {
        it.lastReadAt =
          stateWithReadAt.lastReadAt instanceof Date
            ? stateWithReadAt.lastReadAt.toISOString()
            : (stateWithReadAt.lastReadAt as string);
      }
    }
  }

  // Tags & Zotero Tags
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

  if (Array.isArray(it.itemTags) && it.itemTags.length > 0) {
    const itemTagArr = it.itemTags;
    const rawTagNames = itemTagArr
      .map(
        (t) =>
          (t.tag as { name?: string } | undefined)?.name ||
          (t.name as string | undefined),
      )
      .filter(Boolean) as string[];
    const tagNames = normalizeTags(rawTagNames);
    it.tags = tagNames;
    it.labels = tagNames;
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
      it.labels,
      it.keywords,
      metaObj.tags,
      metaObj.keywords,
      metaObj.labels,
    ]);
    const tagNames = normalizeTags(rawTags as string[]);
    it.tags = tagNames;
    it.labels = tagNames;
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

  // Collections
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

  // Notes
  const normalizeNoteList = (list: Array<Record<string, unknown>>) =>
    list.map((n) => {
      const text = (n.content || n.contentMd || n.note || '') as string;
      return {
        ...n,
        content: text,
        contentMd: n.contentMd || text,
        note: n.note || `<p>${text}</p>`,
        itemType: 'note',
      };
    });

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
          note: `<p>${formatted}</p>`,
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

  if (it.extraFields && 'comment' in it.extraFields) {
    delete it.extraFields.comment;
  }
}

/**
 * Partial 5: Harmonizes Zotero v42 fields, dates, numbers, and identifiers.
 */
function harmonizeDomainMetadataAndIdentifiersPartial(
  it: MutableItemPayload,
): void {
  const extraFields = it.extraFields || {};

  const parsePositiveIntOrNull = (
    val: unknown,
    fallback: unknown,
  ): number | null => {
    const candidate =
      val === undefined || val === null || val === 0 || String(val) === '0'
        ? fallback
        : val;
    const num = candidate ? Number(candidate) : null;
    return num && num > 0 ? num : null;
  };

  it.citationCount = parsePositiveIntOrNull(
    it.citationCount,
    extraFields.citationCount,
  );
  it.referenceCount = parsePositiveIntOrNull(
    it.referenceCount,
    extraFields.referenceCount,
  );
  if (!it.openAccessPdfUrl) {
    it.openAccessPdfUrl =
      (extraFields.openAccessPdfUrl as string | null | undefined) ?? null;
  }
  if (!it.arxivId) {
    it.arxivId =
      (extraFields.arxivId as string | null | undefined) ??
      (extraFields.archiveId as string | null | undefined) ??
      null;
  }

  if (
    !it.proceedingsTitle &&
    (extraFields.proceedingsTitle ||
      (it.itemType === 'conferencePaper' && it.publicationTitle))
  ) {
    it.proceedingsTitle = String(
      extraFields.proceedingsTitle || it.publicationTitle,
    );
  }
  if (
    !it.conferenceName &&
    extraFields.conferenceName &&
    extraFields.conferenceName !== it.proceedingsTitle &&
    extraFields.conferenceName !== it.publicationTitle
  ) {
    it.conferenceName = String(extraFields.conferenceName);
  }

  if (it.abstract || extraFields.abstract || extraFields.abstractNote) {
    const rawAbstract = String(
      it.abstract || extraFields.abstract || extraFields.abstractNote,
    );
    it.abstract = cleanAbstractText(rawAbstract) ?? (it.abstract || null);
  }
  it.abstractNote = it.abstract ?? null;

  if (
    it.year !== undefined &&
    it.year !== null &&
    (it.year === 0 || String(it.year) === '0' || Number(it.year) <= 0)
  ) {
    it.year = null;
  }
  it.date = it.date || it.publicationDate || (it.year ? String(it.year) : null);
  if (it.date === '0' || it.date === '0000') {
    it.date = null;
  }

  for (const field of ['volume', 'issue', 'pages', 'edition'] as const) {
    if (it[field] !== undefined && it[field] !== null) {
      const str = String(it[field]).trim();
      it[field] = str === '0' || str === '' ? null : str;
    }
  }

  const normalizePageCount = (val: unknown): number | string | null => {
    if (val === undefined || val === null) return null;
    const str = String(val).trim();
    if (str === '0' || str === '') return null;
    const num = Number(str);
    return isNaN(num) ? str : num > 0 ? num : null;
  };
  if (it.numPages !== undefined) it.numPages = normalizePageCount(it.numPages);
  if (it.numberOfPages !== undefined) {
    it.numberOfPages = normalizePageCount(it.numberOfPages);
  }

  if (
    it.callNumber &&
    /^arxiv:\s*\d{4}\.\d{4,5}/i.test(String(it.callNumber))
  ) {
    if (!it.arxivId) {
      it.arxivId = String(it.callNumber)
        .replace(/^arxiv:\s*/i, '')
        .trim();
    }
    it.callNumber = null;
  }

  if (it.arxivId || it.archiveId) {
    const rawId = String(it.arxivId || it.archiveId);
    const cleanArxivId = rawId
      .replace(/^arxiv:\s*/i, '')
      .replace(/\s*\[.*?\]\s*$/, '')
      .trim();
    it.arxivId = cleanArxivId;
    const canonicalCleanId = cleanArxivId.replace(/v\d+$/i, '');
    if (it.itemType === 'preprint') {
      it.archiveId = `arXiv:${canonicalCleanId}`;
      it.repository = it.repository || 'arXiv';
    }

    const existingExtra = typeof it.extra === 'string' ? it.extra.trim() : '';
    const catStr = resolveCanonicalArxivCategory(
      canonicalCleanId,
      Array.isArray(it.tags) ? (it.tags as string[]) : undefined,
      extraFields,
      it,
    );

    if (!existingExtra.toLowerCase().includes('arxiv:')) {
      const arxivLine = catStr
        ? `arXiv: ${canonicalCleanId} [${catStr}]`
        : `arXiv: ${canonicalCleanId}`;
      it.extra = existingExtra ? `${arxivLine}\n${existingExtra}` : arxivLine;
    } else {
      it.extra = existingExtra.replace(
        /^arxiv:\s*([^\s[]+)(?:v\d+)?(?:\s*\[([^\]]+)\])?/im,
        (_: string, id: string, cat?: string) => {
          const canonicalId = id.replace(/v\d+$/i, '').trim();
          const finalCat = (cat ? cat.trim() : '') || catStr;
          return finalCat
            ? `arXiv: ${canonicalId} [${finalCat}]`
            : `arXiv: ${canonicalId}`;
        },
      );
    }
  }

  // Zotero v42 Base Field & Alias Harmonization via Single-Source-of-Truth Harmonizer
  const baseMap = it.itemType
    ? getEffectiveBaseFieldMap(it.itemType)
    : undefined;
  resolveBidirectionalBaseFields(it, it.itemType, [it.extraFields], false);
  resolveFieldAliases(it, [it.extraFields]);

  if (baseMap) {
    for (const [baseField, mappedField] of Object.entries(baseMap)) {
      if (!mappedField || mappedField === baseField) continue;
      if (baseField === 'type' || baseField === 'medium') {
        const currentSubtype =
          it.type && it.type.toLowerCase() !== (it.itemType || '').toLowerCase()
            ? it.type
            : undefined;
        it[mappedField] =
          it[mappedField] ||
          (baseField === 'medium' ? it.medium : undefined) ||
          currentSubtype ||
          '';
        if (baseField === 'type' && it[mappedField] && !currentSubtype) {
          it.type = it[mappedField] as string;
        }
        continue;
      }
      if (it[mappedField] === undefined || it[mappedField] === null) {
        it[mappedField] = '';
      }
      if (
        (it[baseField] === undefined || it[baseField] === null) &&
        baseField !== 'status' &&
        baseField !== 'authority' &&
        baseField !== 'originalDate' &&
        baseField !== 'number'
      ) {
        it[baseField] = '';
      }
    }
  }

  it.publicationTitle = it.publicationTitle ?? '';
  it.publisher = it.publisher ?? '';
  it.place = it.place ?? '';
  it.volume = it.volume ?? '';
  it.issue = it.issue ?? '';
  it.pages = it.pages ?? '';

  if (it.itemType === 'journalArticle' || !it.itemType) {
    it.journal = it.journal || it.publicationTitle || '';
    it.publicationTitle = it.publicationTitle || it.journal || '';
  }

  if (it.itemType === 'preprint') {
    const isArxiv = Boolean(
      it.arxivId ||
      it.archiveId ||
      it.archiveID ||
      (it.doi && String(it.doi).includes('arXiv')) ||
      (it.publicationTitle && /arxiv/i.test(it.publicationTitle)),
    );
    it.genre = it.genre || it.type || 'Preprint';
    const cleanArxivNum = it.arxivId
      ? String(it.arxivId)
          .replace(/^arxiv:\s*/i, '')
          .replace(/v\d+$/i, '')
          .trim()
      : '';
    it.archiveID =
      it.archiveID || (cleanArxivNum ? `arXiv:${cleanArxivNum}` : '') || '';
    it.archiveId = it.archiveID;
    it.repository =
      it.repository ||
      (it.publisher && !/^arxiv$/i.test(String(it.publisher).trim())
        ? (it.publisher as string)
        : '') ||
      (isArxiv ? 'arXiv' : '') ||
      '';
    delete it.publisher;
    delete it.publicationTitle;
    delete it.journal;
  } else if (it.itemType === 'thesis') {
    it.thesisType =
      it.thesisType ||
      (it.type && it.type.toLowerCase() !== 'thesis' ? it.type : undefined) ||
      it.genre ||
      '';
  } else if (it.itemType === 'patent') {
    it.issuingAuthority =
      it.issuingAuthority || it.country || it.authority || '';
    it.authority = it.authority || it.issuingAuthority || '';
    it.country = it.country || it.issuingAuthority || '';
    it.patentNumber = it.patentNumber || it.number || '';
    it.issueDate = it.issueDate || it.date || it.publicationDate || '';
    it.priorityDate = it.priorityDate || it.originalDate || '';
    it.assignee = it.assignee || '';
  }

  if (
    it.year === undefined ||
    it.year === null ||
    isNaN(Number(it.year)) ||
    Number(it.year) === 0
  ) {
    const dateCandidate =
      it.date ||
      it.publicationDate ||
      it.issueDate ||
      it.dateDecided ||
      it.dateEnacted ||
      it.filingDate;
    if (dateCandidate) {
      const yearMatch = String(dateCandidate).match(
        /(?:^|[^\d])(1[7-9]\d{2}|20\d{2})(?:[^\d]|$)/,
      );
      if (yearMatch) {
        it.year = parseInt(yearMatch[1], 10);
      }
    }
  } else if (typeof it.year === 'string') {
    const parsedNum = parseInt(it.year, 10);
    it.year = isNaN(parsedNum) ? null : parsedNum;
  }

  it.publicationDate =
    it.publicationDate || it.date || (it.year ? String(it.year) : '');
  it.date = it.date || it.publicationDate || (it.year ? String(it.year) : '');
  it.abstract = it.abstract || it.abstractNote || '';
  it.abstractNote = it.abstract;
  it.journalAbbreviation = it.journalAbbreviation || it.journalAbbr || '';
  it.journalAbbr = it.journalAbbr || it.journalAbbreviation || '';
  it.accessDate =
    it.accessDate ||
    (it.accessedAt
      ? it.accessedAt instanceof Date
        ? it.accessedAt.toISOString()
        : String(it.accessedAt)
      : '');
  it.citationKey = it.citationKey || it.citeKey || '';
  it.citeKey = it.citeKey || it.citationKey || '';
  it.url = it.url || it.URL || '';
  it.URL = it.url;

  // Identifier Projections
  if (Array.isArray(it.identifiers)) {
    const idTypeToField: Record<string, keyof MutableItemPayload> = {
      arxiv: 'arxivId',
      doi: 'doi',
      pmid: 'pmid',
      pmcid: 'pmcid',
      isbn: 'isbn',
      issn: 'issn',
    };
    for (const ident of it.identifiers) {
      const type = (ident.type || ident.identifierType || '').toLowerCase();
      const targetKey = idTypeToField[type];
      if (targetKey && !it[targetKey]) {
        it[targetKey] = ident.value;
      }
    }
  }

  for (const [lowerKey, upperKey] of [
    ['doi', 'DOI'],
    ['isbn', 'ISBN'],
    ['issn', 'ISSN'],
    ['pmid', 'PMID'],
    ['pmcid', 'PMCID'],
  ] as const) {
    if (!it[lowerKey] && (extraFields[lowerKey] || extraFields[upperKey])) {
      it[lowerKey] = String(extraFields[lowerKey] || extraFields[upperKey]);
    }
    const canonicalVal =
      (it[lowerKey] as string) || (it[upperKey] as string) || '';
    it[lowerKey] = canonicalVal;
    it[upperKey] = canonicalVal;
  }

  const canonicalArxivId =
    it.arxivId ||
    it.archiveId ||
    it.archiveID ||
    extraFields.arxivId ||
    extraFields.archiveId ||
    extraFields.archiveID ||
    '';
  const cleanArxiv = canonicalArxivId
    ? String(canonicalArxivId)
        .replace(/^arxiv:\s*/i, '')
        .replace(/\s*\[.*?\]\s*$/, '')
        .trim()
    : '';
  it.arxivId = cleanArxiv;
  it.archiveId = cleanArxiv
    ? it.itemType === 'preprint'
      ? `arXiv:${cleanArxiv.replace(/v\d+$/i, '')}`
      : cleanArxiv
    : it.archiveId || '';
  it.archiveID = it.archiveID || it.archiveId;

  // Sync non-column Zotero v42 fields into extraFields
  if (it.extraFields && typeof it.extraFields === 'object') {
    for (const fieldKey of TYPE_SPECIFIC_EXTRA_FIELDS) {
      const topVal = it[fieldKey];
      if (
        topVal !== undefined &&
        topVal !== null &&
        topVal !== '' &&
        it.extraFields[fieldKey] === undefined
      ) {
        it.extraFields[fieldKey] = topVal;
      }
    }
    if (baseMap) {
      for (const mappedField of Object.values(baseMap)) {
        const topVal = it[mappedField];
        if (
          mappedField &&
          topVal !== undefined &&
          topVal !== null &&
          topVal !== '' &&
          !ITEM_COLUMN_METADATA_FIELDS.has(mappedField) &&
          it.extraFields[mappedField] === undefined
        ) {
          it.extraFields[mappedField] = topVal;
        }
      }
    }
  }

  if (!Array.isArray(it.identifiers) || it.identifiers.length === 0) {
    const idDefs: ReadonlyArray<{
      type: string;
      val: string | null | undefined;
      uri: (v: string) => string;
    }> = [
      { type: 'doi', val: it.doi, uri: (v) => `https://doi.org/${v}` },
      {
        type: 'arxiv',
        val: it.arxivId,
        uri: (v) => `https://arxiv.org/abs/${v}`,
      },
      {
        type: 'pmid',
        val: it.pmid,
        uri: (v) => `https://pubmed.ncbi.nlm.nih.gov/${v}/`,
      },
      {
        type: 'pmcid',
        val: it.pmcid,
        uri: (v) => `https://pmc.ncbi.nlm.nih.gov/articles/${v}/`,
      },
      { type: 'isbn', val: it.isbn, uri: (v) => `urn:isbn:${v}` },
      { type: 'issn', val: it.issn, uri: (v) => `urn:issn:${v}` },
    ];
    it.identifiers = idDefs
      .filter((d): d is typeof d & { val: string } => Boolean(d.val))
      .map((d) => ({
        type: d.type,
        value: d.val,
        canonicalUri: d.uri(d.val),
      }));
  }
}

/**
 * Partial 6: Projects My Publications and Item Relations.
 */
function mapPublicationsAndRelationsPartial(it: MutableItemPayload): void {
  const metaObj = parseJsonObject(it.metadata);
  if (it.isMyPublication === undefined) {
    it.isMyPublication =
      (Array.isArray(it.publications) && it.publications.length > 0) ||
      Boolean(metaObj?.isMyPublication);
  } else {
    it.isMyPublication = Boolean(it.isMyPublication);
  }

  const combinedRelations: Array<Record<string, unknown>> = [];
  if (Array.isArray(it.outgoingRel)) {
    for (const rel of it.outgoingRel) {
      combinedRelations.push({
        id: rel.id,
        targetItemId: rel.targetItemId,
        relationType: rel.relationType || 'related',
        direction: 'outgoing',
        description: rel.description || '',
        linkedAt: rel.createdAt,
        targetItem: rel.targetItem
          ? ItemMapper.toDomain(rel.targetItem)
          : undefined,
      });
    }
  }
  if (Array.isArray(it.incomingRel)) {
    for (const rel of it.incomingRel) {
      combinedRelations.push({
        id: rel.id,
        targetItemId: rel.sourceItemId,
        relationType: rel.relationType || 'related',
        direction: 'incoming',
        description: rel.description || '',
        linkedAt: rel.createdAt,
        targetItem: rel.sourceItem
          ? ItemMapper.toDomain(rel.sourceItem)
          : undefined,
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

export class ItemsMapper {
  /**
   * Normalizes a single Item record or payload to the canonical domain shape
   * by composing small, single-responsibility partial mappers.
   */
  static toDomain<T>(item: T): T {
    if (!item || typeof item !== 'object') return item;
    const it: MutableItemPayload = { ...(item as MutableItemPayload) };

    unpackMetadataAndExtraPartial(it);
    const primaryPdf = mapAttachmentsAndPrimaryFilePartial(it);
    mapCreatorsPartial(it);
    mapTagsCollectionsNotesPartial(it);
    harmonizeDomainMetadataAndIdentifiersPartial(it);
    finalizePrimaryFilePartial(it, primaryPdf);
    mapPublicationsAndRelationsPartial(it);

    return it as T;
  }

  /**
   * Normalizes an array of Item records.
   */
  static toDomainList<T>(items: T[]): T[] {
    if (!Array.isArray(items)) return items;
    return items.map((item) => ItemMapper.toDomain(item));
  }

  /**
   * Projects user state (readStatus, rating, lastReadAt) to top level of domain item.
   */
  static mapFlattenedState<T extends Record<string, unknown>>(
    item: T | null | undefined,
    userId?: string,
  ):
    | (T & { readStatus: string; rating: number; lastReadAt: string | null })
    | null {
    if (!item) return null;
    interface StateRecordLike {
      userId?: string;
      readStatus?: string;
      rating?: number;
      lastReadAt?: Date | string | null;
      [key: string]: unknown;
    }
    const normalized = ItemMapper.toDomain(item) as Record<string, unknown>;
    const statesArr =
      Array.isArray(normalized.userStates) && normalized.userStates.length > 0
        ? (normalized.userStates as StateRecordLike[])
        : Array.isArray(normalized.states) && normalized.states.length > 0
          ? (normalized.states as StateRecordLike[])
          : null;

    const userState = statesArr
      ? (userId && statesArr.find((s) => s.userId === userId)) || statesArr[0]
      : undefined;

    const { userStates: _userStates, states: _states, ...rest } = normalized;
    return {
      ...rest,
      isStarred:
        userState?.isStarred !== undefined
          ? Boolean(userState.isStarred)
          : Boolean(normalized.isStarred),
      readStatus: userState?.readStatus ?? 'unread',
      rating: userState?.rating ?? 0,
      lastReadAt: userState?.lastReadAt
        ? userState.lastReadAt instanceof Date
          ? userState.lastReadAt.toISOString()
          : String(userState.lastReadAt)
        : null,
    } as unknown as T & {
      readStatus: string;
      rating: number;
      lastReadAt: string | null;
    };
  }
}

export const ItemMapper = ItemsMapper;
export type ItemMapper = ItemsMapper;
