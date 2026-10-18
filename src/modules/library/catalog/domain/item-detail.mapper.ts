import { getFileContentPath } from '@/modules/storage/storage.port';
import {
  ITEM_COLUMN_METADATA_FIELDS,
  TYPE_SPECIFIC_EXTRA_FIELDS,
} from '@/modules/library/catalog/types/items.constants';
import { cleanCommentText } from '@/modules/library/core';
import {
  MutableItemPayload,
  AttachmentLike,
  parseJsonObject,
} from './item-mapper.types';

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

/**
 * Partial 1: Unpacks PostgreSQL JsonB `metadata` and `extra` / `extraFields`
 * into top-level domain properties and normalized `extraFields`.
 */
export function unpackMetadataAndExtraPartial(it: MutableItemPayload): void {
  const metaObj = parseJsonObject(it.metadata);
  const hasRelationalItemTags = Array.isArray(it.itemTags);
  if (metaObj) {
    for (const [key, value] of Object.entries(metaObj)) {
      if (
        hasRelationalItemTags &&
        (key === 'tags' || key === 'keywords' || key === 'zoteroTags')
      ) {
        continue;
      }
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
 * Partial 6: Projects My Publications and Item Relations.
 */
export function mapPublicationsAndRelationsPartial(
  it: MutableItemPayload,
  toDomainFn: <T>(item: T) => T,
): void {
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
        targetItem: rel.targetItem ? toDomainFn(rel.targetItem) : undefined,
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
        targetItem: rel.sourceItem ? toDomainFn(rel.sourceItem) : undefined,
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
