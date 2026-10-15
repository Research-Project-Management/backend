import { WorkItemAttachments } from '@/modules/work-item/core/types/work-item.types';

export interface AttachmentMetadata {
  pageId?: string;
  paperId?: string;
  fileId?: string;
  category?: string;
  title?: string;
  slug?: string;
  doi?: string;
  citationKey?: string;
  [key: string]: unknown;
}

export interface RawAttachmentRecord {
  id: string;
  entityId?: string;
  metadata?: unknown;
  mimeType?: string | null;
  filename?: string | null;
  url?: string | null;
  size?: number | null;
  createdAt?: Date | string | null;
  [key: string]: unknown;
}

export function getAttachmentMeta(
  attachment: { metadata?: unknown } | null | undefined,
): AttachmentMetadata {
  if (
    attachment?.metadata &&
    typeof attachment.metadata === 'object' &&
    !Array.isArray(attachment.metadata)
  ) {
    return attachment.metadata as AttachmentMetadata;
  }
  return {};
}

export function formatEntityAttachments(
  records: RawAttachmentRecord[],
): Required<WorkItemAttachments> {
  const pages: NonNullable<WorkItemAttachments['pages']> = [];
  const papers: NonNullable<WorkItemAttachments['papers']> = [];
  const files: NonNullable<WorkItemAttachments['files']> = [];
  const links: NonNullable<WorkItemAttachments['links']> = [];

  const safeRecords = Array.isArray(records) ? records : [];
  for (const r of safeRecords) {
    const meta = getAttachmentMeta(r);
    const category =
      (typeof meta.category === 'string' ? meta.category : undefined) ||
      (r.mimeType === 'application/x-page'
        ? 'page'
        : r.mimeType === 'application/x-paper'
          ? 'paper'
          : r.mimeType === 'text/uri-list'
            ? 'link'
            : 'file');
    const isoDate = r.createdAt
      ? new Date(r.createdAt).toISOString()
      : new Date().toISOString();

    if (category === 'page') {
      pages.push({
        id: r.id,
        pageId: typeof meta.pageId === 'string' ? meta.pageId : r.id,
        title:
          typeof meta.title === 'string'
            ? meta.title
            : r.filename || 'Untitled Page',
        slug: typeof meta.slug === 'string' ? meta.slug : null,
        addedAt: isoDate,
      });
    } else if (category === 'paper') {
      papers.push({
        id: r.id,
        paperId: typeof meta.paperId === 'string' ? meta.paperId : r.id,
        title:
          typeof meta.title === 'string'
            ? meta.title
            : r.filename || 'Untitled Paper',
        doi: typeof meta.doi === 'string' ? meta.doi : null,
        citationKey:
          typeof meta.citationKey === 'string' ? meta.citationKey : null,
        addedAt: isoDate,
      });
    } else if (category === 'link') {
      links.push({
        id: r.id,
        title:
          typeof meta.title === 'string'
            ? meta.title
            : r.filename || r.url || 'Link',
        url: r.url || '',
        addedAt: isoDate,
      });
    } else {
      files.push({
        id: r.id,
        name: r.filename || 'file',
        url: r.url || '',
        size: typeof r.size === 'number' ? r.size : null,
        type: r.mimeType || 'application/octet-stream',
        createdAt: isoDate,
        uploadedAt: isoDate,
      });
    }
  }

  return { pages, papers, files, links };
}
