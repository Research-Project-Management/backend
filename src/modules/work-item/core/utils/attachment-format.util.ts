import { WorkItemAttachments } from '../types/work-item.types';

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

export function formatEntityAttachments(
  records: RawAttachmentRecord[],
): WorkItemAttachments {
  const pages: NonNullable<WorkItemAttachments['pages']> = [];
  const papers: NonNullable<WorkItemAttachments['papers']> = [];
  const files: NonNullable<WorkItemAttachments['files']> = [];
  const links: NonNullable<WorkItemAttachments['links']> = [];

  const safeRecords = Array.isArray(records) ? records : [];
  for (const r of safeRecords) {
    const meta =
      r.metadata && typeof r.metadata === 'object' && !Array.isArray(r.metadata)
        ? (r.metadata as Record<string, unknown>)
        : {};
    const category =
      (typeof meta.category === 'string' ? meta.category : undefined) ||
      (r.mimeType === 'application/x-page'
        ? 'page'
        : r.mimeType === 'application/x-paper'
          ? 'paper'
          : r.mimeType === 'text/uri-list'
            ? 'link'
            : 'file');

    if (category === 'page') {
      pages.push({
        id: r.id,
        title:
          typeof meta.title === 'string'
            ? meta.title
            : r.filename || 'Untitled Page',
        slug: typeof meta.slug === 'string' ? meta.slug : null,
        addedAt: r.createdAt
          ? new Date(r.createdAt).toISOString()
          : new Date().toISOString(),
      });
    } else if (category === 'paper') {
      papers.push({
        id: r.id,
        title:
          typeof meta.title === 'string'
            ? meta.title
            : r.filename || 'Untitled Paper',
        doi: typeof meta.doi === 'string' ? meta.doi : null,
        citationKey:
          typeof meta.citationKey === 'string' ? meta.citationKey : null,
        addedAt: r.createdAt
          ? new Date(r.createdAt).toISOString()
          : new Date().toISOString(),
      });
    } else if (category === 'link') {
      links.push({
        title:
          typeof meta.title === 'string' ? meta.title : r.filename || 'Link',
        url: r.url || '',
        addedAt: r.createdAt
          ? new Date(r.createdAt).toISOString()
          : new Date().toISOString(),
      });
    } else {
      files.push({
        id: r.id,
        name: r.filename || 'file',
        url: r.url || '',
        size: typeof r.size === 'number' ? r.size : null,
        type: r.mimeType || 'application/octet-stream',
        uploadedAt: r.createdAt
          ? new Date(r.createdAt).toISOString()
          : new Date().toISOString(),
      });
    }
  }

  return { pages, papers, files, links };
}
