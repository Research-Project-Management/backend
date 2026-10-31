import { CreateItemData } from '@/modules/library/core/types/bibliographic.types';
import { mergeCanonicalCreators } from '@/modules/library/core';
import { ItemsMapper } from './items.mapper';

export interface ImportSourceItem {
  title: string;
  year?: number | null;
  doi?: string | null;
  abstract?: string | null;
  itemType?: string | null;
  publicationTitle?: string | null;
  publicationDate?: string | null;
  publisher?: string | null;
  place?: string | null;
  volume?: string | null;
  issue?: string | null;
  section?: string | null;
  partNumber?: string | null;
  partTitle?: string | null;
  pages?: string | null;
  series?: string | null;
  seriesTitle?: string | null;
  seriesText?: string | null;
  seriesNumber?: string | null;
  edition?: string | null;
  accessedAt?: string | null;
  isRetracted?: boolean | null;
  retractionNature?: string | null;
  retractionDetails?: string | null;
  retractionCheckedAt?: string | Date | null;
  fieldProvenance?: Record<string, unknown> | null;
  lockedFields?: string[] | null;
  issn?: string | null;
  isbn?: string | null;
  pmid?: string | null;
  pmcid?: string | null;
  url?: string | null;
  language?: string | null;
  journalAbbr?: string | null;
  shortTitle?: string | null;
  rights?: string | null;
  license?: string | null;
  citationKey?: string | null;
  libraryCatalog?: string | null;
  archive?: string | null;
  archiveLocation?: string | null;
  callNumber?: string | null;
  extra?: string | null;
  arxivId?: string | null;
  citationCount?: number | null;
  referenceCount?: number | null;
  openAccessPdfUrl?: string | null;
  fileId?: string | null;
  fileUrl?: string | null;
  filename?: string | null;
  mimeType?: string | null;
  size?: number | bigint | null;
  fileHash?: string | null;
  attachments?: Array<{
    fileId?: string | null;
    url?: string | null;
    filename?: string | null;
    name?: string | null;
    mimeType?: string | null;
    size?: number | bigint | null;
    fileHash?: string | null;
  }>;
  itemTags?: Array<{ tag?: { name?: string } }>;
  notesList?: Array<{ title?: string; contentMd?: string; tags?: string[] }>;
  contributors?: Array<{
    creatorType?: string;
    firstName?: string | null;
    lastName?: string | null;
    fullName?: string;
    orderIndex?: number;
  }>;
  identifiers?: Array<{
    type: string;
    value: string;
    canonicalUri?: string | null;
  }>;
  [key: string]: unknown;
}

export function buildImportItemPayload(
  rawSource: ImportSourceItem,
  userId: string,
): CreateItemData {
  const unpacked = ItemsMapper.toDomain(rawSource) as Record<string, unknown>;
  const source: ImportSourceItem = {
    ...unpacked,
    ...rawSource,
    publicationDate:
      rawSource.publicationDate ??
      (unpacked.publicationDate as string | null | undefined) ??
      (unpacked.date as string | null | undefined),
    publisher:
      rawSource.publisher ?? (unpacked.publisher as string | null | undefined),
    place: rawSource.place ?? (unpacked.place as string | null | undefined),
    volume: rawSource.volume ?? (unpacked.volume as string | null | undefined),
    issue: rawSource.issue ?? (unpacked.issue as string | null | undefined),
    section:
      rawSource.section ?? (unpacked.section as string | null | undefined),
    partNumber:
      rawSource.partNumber ??
      (unpacked.partNumber as string | null | undefined),
    partTitle:
      rawSource.partTitle ?? (unpacked.partTitle as string | null | undefined),
    pages: rawSource.pages ?? (unpacked.pages as string | null | undefined),
    series: rawSource.series ?? (unpacked.series as string | null | undefined),
    seriesTitle:
      rawSource.seriesTitle ??
      (unpacked.seriesTitle as string | null | undefined),
    seriesText:
      rawSource.seriesText ??
      (unpacked.seriesText as string | null | undefined),
    seriesNumber:
      rawSource.seriesNumber ??
      (unpacked.seriesNumber as string | null | undefined),
    edition:
      rawSource.edition ?? (unpacked.edition as string | null | undefined),
    accessedAt:
      rawSource.accessedAt ??
      (unpacked.accessedAt as string | null | undefined),
    isRetracted:
      rawSource.isRetracted ??
      (unpacked.isRetracted as boolean | null | undefined),
    retractionNature:
      rawSource.retractionNature ??
      (unpacked.retractionNature as string | null | undefined),
    retractionDetails:
      rawSource.retractionDetails ??
      (unpacked.retractionDetails as string | null | undefined),
    retractionCheckedAt:
      rawSource.retractionCheckedAt ??
      (unpacked.retractionCheckedAt as string | Date | null | undefined),
    fieldProvenance:
      rawSource.fieldProvenance ??
      (unpacked.fieldProvenance as Record<string, unknown> | null | undefined),
    lockedFields:
      rawSource.lockedFields ??
      (unpacked.lockedFields as string[] | null | undefined),
    issn: rawSource.issn ?? (unpacked.issn as string | null | undefined),
    isbn: rawSource.isbn ?? (unpacked.isbn as string | null | undefined),
    pmid: rawSource.pmid ?? (unpacked.pmid as string | null | undefined),
    pmcid: rawSource.pmcid ?? (unpacked.pmcid as string | null | undefined),
    arxivId:
      rawSource.arxivId ?? (unpacked.arxivId as string | null | undefined),
    language:
      rawSource.language ?? (unpacked.language as string | null | undefined),
    journalAbbr:
      rawSource.journalAbbr ??
      (unpacked.journalAbbreviation as string | null | undefined) ??
      (unpacked.journalAbbr as string | null | undefined),
    shortTitle:
      rawSource.shortTitle ??
      (unpacked.shortTitle as string | null | undefined),
    rights: rawSource.rights ?? (unpacked.rights as string | null | undefined),
    license:
      rawSource.license ?? (unpacked.license as string | null | undefined),
    libraryCatalog:
      rawSource.libraryCatalog ??
      (unpacked.libraryCatalog as string | null | undefined),
    archive:
      rawSource.archive ?? (unpacked.archive as string | null | undefined),
    archiveLocation:
      rawSource.archiveLocation ??
      (unpacked.archiveLocation as string | null | undefined),
    callNumber:
      rawSource.callNumber ??
      (unpacked.callNumber as string | null | undefined),
    extra: rawSource.extra ?? (unpacked.extra as string | null | undefined),
    citationCount:
      rawSource.citationCount ??
      (unpacked.citationCount as number | null | undefined),
    referenceCount:
      rawSource.referenceCount ??
      (unpacked.referenceCount as number | null | undefined),
    openAccessPdfUrl:
      rawSource.openAccessPdfUrl ??
      (unpacked.openAccessPdfUrl as string | null | undefined),
  };
  const primaryAttachment = rawSource.attachments?.[0];
  const resolvedFileId = primaryAttachment?.fileId
    ? String(primaryAttachment.fileId)
    : source.fileId
      ? String(source.fileId)
      : undefined;
  const resolvedFileUrl = primaryAttachment?.url || source.fileUrl || undefined;
  const resolvedFilename =
    primaryAttachment?.filename ||
    primaryAttachment?.name ||
    source.filename ||
    undefined;
  const resolvedMimeType =
    primaryAttachment?.mimeType || source.mimeType || undefined;
  const rawSize = primaryAttachment?.size ?? source.size;
  const resolvedSize =
    rawSize !== undefined && rawSize !== null ? Number(rawSize) : undefined;
  const resolvedFileHash =
    primaryAttachment?.fileHash || source.fileHash || undefined;

  const clonedAttachments = (source.attachments || []).map((att) => ({
    title: att.name || att.filename || 'document.pdf',
    filename: att.filename || att.name || 'document.pdf',
    url: att.url || (att.fileId ? `/api/files/${att.fileId}/content` : ''),
    fileId: att.fileId ? String(att.fileId) : null,
    fileHash: att.fileHash || '',
    mimeType: att.mimeType || 'application/pdf',
    size: att.size !== undefined && att.size !== null ? Number(att.size) : 0,
    linkMode: (att as Record<string, unknown>).linkMode as string | undefined,
    attachmentType: (att as Record<string, unknown>).attachmentType as
      string | undefined,
    metadata: (att as Record<string, unknown>).metadata as
      Record<string, unknown> | undefined,
    annotations: Array.isArray((att as Record<string, unknown>).annotations)
      ? (
          (att as Record<string, unknown>).annotations as Array<
            Record<string, unknown>
          >
        )
          .filter((ann) => ann && !ann.deletedAt)
          .map((ann) => ({
            type: ann.type || 'highlight',
            color: ann.color || '#ffd400',
            pageIndex: typeof ann.pageIndex === 'number' ? ann.pageIndex : 0,
            pageLabel: typeof ann.pageLabel === 'string' ? ann.pageLabel : '',
            annotationSortIndex:
              typeof ann.annotationSortIndex === 'string'
                ? ann.annotationSortIndex
                : '',
            rectCoords: ann.rectCoords ?? null,
            quoteText: typeof ann.quoteText === 'string' ? ann.quoteText : null,
            comment: typeof ann.comment === 'string' ? ann.comment : '',
            tags: Array.isArray(ann.tags) ? (ann.tags as string[]) : [],
            authorId: userId,
          }))
      : [],
  }));

  return {
    title: source.title,
    attachmentCount: clonedAttachments.length,
    attachments: clonedAttachments,
    uploadedById: userId,
    year: source.year ?? undefined,
    doi: source.doi ?? undefined,
    abstract: source.abstract ?? undefined,
    itemType: source.itemType || 'journalArticle',
    publicationTitle: source.publicationTitle ?? undefined,
    publicationDate: source.publicationDate ?? undefined,
    publisher: source.publisher ?? undefined,
    place: source.place ?? undefined,
    volume: source.volume ?? undefined,
    issue: source.issue ?? undefined,
    section: source.section ?? undefined,
    partNumber: source.partNumber ?? undefined,
    partTitle: source.partTitle ?? undefined,
    pages: source.pages ?? undefined,
    series: source.series ?? undefined,
    seriesTitle: source.seriesTitle ?? undefined,
    seriesText: source.seriesText ?? undefined,
    seriesNumber: source.seriesNumber ?? undefined,
    edition: source.edition ?? undefined,
    accessedAt: source.accessedAt ? new Date(source.accessedAt) : undefined,
    isRetracted: source.isRetracted ?? undefined,
    retractionNature: source.retractionNature ?? undefined,
    retractionDetails: source.retractionDetails ?? undefined,
    retractionCheckedAt: source.retractionCheckedAt ?? undefined,
    fieldProvenance: source.fieldProvenance ?? undefined,
    lockedFields: source.lockedFields ?? undefined,
    issn: source.issn ?? undefined,
    isbn: source.isbn ?? undefined,
    pmid: source.pmid ?? undefined,
    pmcid: source.pmcid ?? undefined,
    url: source.url ?? undefined,
    language: source.language ?? undefined,
    journalAbbr: source.journalAbbr ?? undefined,
    shortTitle: source.shortTitle ?? undefined,
    rights: source.rights ?? undefined,
    license: source.license ?? undefined,
    citationKey: source.citationKey ?? undefined,
    libraryCatalog: source.libraryCatalog ?? undefined,
    archive: source.archive ?? undefined,
    archiveLocation: source.archiveLocation ?? undefined,
    callNumber: source.callNumber ?? undefined,
    extra: source.extra ?? undefined,
    extraFields:
      (unpacked.extraFields as Record<string, unknown> | undefined) ??
      undefined,
    arxivId: source.arxivId ?? undefined,
    citationCount: source.citationCount ?? undefined,
    referenceCount: source.referenceCount ?? undefined,
    openAccessPdfUrl: source.openAccessPdfUrl ?? undefined,
    fileId: resolvedFileId,
    fileUrl: resolvedFileUrl,
    filename: resolvedFilename,
    mimeType: resolvedMimeType,
    size: resolvedSize,
    fileHash: resolvedFileHash,
    tags:
      source.itemTags
        ?.map((itemTag: { tag?: { name?: string } }) => itemTag.tag?.name)
        .filter((tagName: unknown): tagName is string => Boolean(tagName)) ||
      [],
    notes:
      source.notesList?.map(
        (note: { title?: string; contentMd?: string; tags?: string[] }) => ({
          title: note.title,
          contentMd: note.contentMd,
          content: note.contentMd,
          tags: note.tags || [],
        }),
      ) || [],
    creators: mergeCanonicalCreators({
      contributors: source.contributors,
      itemType: source.itemType || 'journalArticle',
    }),
    identifiers: source.identifiers?.map((identifier) => ({
      type: identifier.type,
      value: identifier.value,
      canonicalUri: identifier.canonicalUri ?? undefined,
    })),
  };
}
