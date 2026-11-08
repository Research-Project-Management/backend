import { Prisma, EntityType } from '@prisma/client';
import { WorkItemAttachments } from '@/modules/project/work-item/core/types/core.types';

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

interface RawPageAttachment {
  id?: string;
  pageId?: string;
  title?: string;
}

interface RawPaperAttachment {
  id?: string;
  paperId?: string;
  title?: string;
  doi?: string | null;
  citationKey?: string | null;
}

interface RawFileAttachment {
  id?: string;
  fileId?: string;
  name?: string;
  filename?: string;
  url?: string;
  type?: string | null;
  mimeType?: string | null;
  size?: number | string | null;
}

interface RawLinkAttachment {
  id?: string;
  title?: string;
  url?: string;
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

export type AttachmentCategoryType = 'page' | 'paper' | 'link' | 'file';

export const MIME_TO_ATTACHMENT_CATEGORY: Readonly<
  Record<string, AttachmentCategoryType>
> = {
  'application/x-page': 'page',
  'application/x-flux-page': 'page',
  'application/x-paper': 'paper',
  'application/x-flux-paper': 'paper',
  'text/uri-list': 'link',
};

export function resolveAttachmentCategory(
  mimeType?: string | null,
  metadata?: unknown,
): AttachmentCategoryType {
  const meta = getAttachmentMeta({ metadata });
  if (typeof meta.category === 'string' && meta.category.trim()) {
    const normalized = meta.category.toLowerCase().trim();
    if (normalized === 'page' || normalized === 'pages') return 'page';
    if (normalized === 'paper' || normalized === 'papers') return 'paper';
    if (normalized === 'link' || normalized === 'links') return 'link';
    if (normalized === 'file' || normalized === 'files') return 'file';
  }
  if (mimeType && MIME_TO_ATTACHMENT_CATEGORY[mimeType]) {
    return MIME_TO_ATTACHMENT_CATEGORY[mimeType];
  }
  return 'file';
}

export function resolveAttachmentFilterPluralCategory(
  mimeType?: string | null,
  metadata?: unknown,
): 'pages' | 'papers' | 'links' | 'files' {
  const single = resolveAttachmentCategory(mimeType, metadata);
  return `${single}s` as 'pages' | 'papers' | 'links' | 'files';
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
    const category = resolveAttachmentCategory(r.mimeType, r.metadata);
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

export function buildAttachmentRecords(
  workItemId: string,
  projectId: string,
  authorId?: string,
  attachments?: WorkItemAttachments | Record<string, unknown>,
): Prisma.EntityAttachmentCreateManyInput[] {
  if (!attachments || typeof attachments !== 'object') {
    return [];
  }

  const records: Prisma.EntityAttachmentCreateManyInput[] = [];
  const source = attachments as {
    pages?: RawPageAttachment[];
    papers?: RawPaperAttachment[];
    files?: RawFileAttachment[];
    links?: RawLinkAttachment[];
  };

  if (Array.isArray(source.pages)) {
    for (const p of source.pages) {
      if (!p || typeof p !== 'object') continue;
      const pageId = p.pageId || p.id;
      if (pageId) {
        records.push({
          entityType: EntityType.work_item,
          entityId: workItemId,
          spaceId: projectId,
          createdById: authorId,
          filename: p.title || 'Untitled Page',
          url: `/pages/${pageId}`,
          mimeType: 'application/x-page',
          size: 0,
          metadata: {
            category: 'page',
            pageId,
            title: p.title,
          },
        });
      }
    }
  }

  if (Array.isArray(source.papers)) {
    for (const p of source.papers) {
      if (!p || typeof p !== 'object') continue;
      const paperId = p.paperId || p.id;
      if (paperId) {
        records.push({
          entityType: EntityType.work_item,
          entityId: workItemId,
          spaceId: projectId,
          createdById: authorId,
          filename: p.title || 'Untitled Paper',
          url: p.doi ? `https://doi.org/${p.doi}` : '',
          mimeType: 'application/x-paper',
          size: 0,
          metadata: {
            category: 'paper',
            paperId,
            title: p.title,
            doi: p.doi ?? undefined,
            citationKey: p.citationKey ?? undefined,
          },
        });
      }
    }
  }

  if (Array.isArray(source.files)) {
    for (const f of source.files) {
      if (!f || typeof f !== 'object') continue;
      if (f.url) {
        records.push({
          entityType: EntityType.work_item,
          entityId: workItemId,
          spaceId: projectId,
          createdById: authorId,
          filename: f.name || f.filename || 'file',
          url: f.url,
          mimeType: f.type || f.mimeType || 'application/octet-stream',
          size: typeof f.size === 'number' ? f.size : 0,
          metadata: {
            category: 'file',
            name: f.name || f.filename,
            ...(f.fileId ? { fileId: f.fileId } : {}),
          },
        });
      }
    }
  }

  if (Array.isArray(source.links)) {
    for (const l of source.links) {
      if (!l || typeof l !== 'object') continue;
      if (l.url) {
        records.push({
          entityType: EntityType.work_item,
          entityId: workItemId,
          spaceId: projectId,
          createdById: authorId,
          filename: l.title || l.url,
          url: l.url,
          mimeType: 'text/uri-list',
          size: 0,
          metadata: { category: 'link', url: l.url, title: l.title },
        });
      }
    }
  }

  return records;
}

export function extractEntityLinkInputs(
  workItemId: string,
  attachments?: WorkItemAttachments | Record<string, unknown>,
): Prisma.WorkItemEntityLinkCreateManyInput[] {
  if (!attachments || typeof attachments !== 'object') return [];
  const source = attachments as {
    pages?: RawPageAttachment[];
    papers?: RawPaperAttachment[];
  };
  const links: Prisma.WorkItemEntityLinkCreateManyInput[] = [];
  if (Array.isArray(source.pages)) {
    for (const p of source.pages) {
      if (!p || typeof p !== 'object') continue;
      const pageId = p.pageId || p.id;
      if (pageId) {
        links.push({
          workItemId,
          entityType: EntityType.page,
          entityId: pageId,
          description: p.title || 'Untitled Page',
        });
      }
    }
  }
  if (Array.isArray(source.papers)) {
    for (const p of source.papers) {
      if (!p || typeof p !== 'object') continue;
      const paperId = p.paperId || p.id;
      if (paperId) {
        links.push({
          workItemId,
          entityType: EntityType.paper,
          entityId: paperId,
          description: p.title || 'Untitled Paper',
        });
      }
    }
  }
  return links;
}

export async function saveInitialAttachments(
  client: {
    entityAttachment?: {
      createMany: (args: {
        data: Prisma.EntityAttachmentCreateManyInput[];
      }) => Promise<unknown>;
    };
    workItemEntityLink?: {
      createMany: (args: {
        data: Prisma.WorkItemEntityLinkCreateManyInput[];
        skipDuplicates?: boolean;
      }) => Promise<unknown>;
    };
  },
  workItemId: string,
  projectId: string,
  authorId: string,
  attachments?: WorkItemAttachments | Record<string, unknown>,
): Promise<void> {
  if (!client.entityAttachment) return;
  const records = buildAttachmentRecords(
    workItemId,
    projectId,
    authorId,
    attachments,
  );
  if (records.length > 0) {
    await client.entityAttachment.createMany({ data: records });
  }
  if (client.workItemEntityLink?.createMany) {
    const entityLinks = extractEntityLinkInputs(workItemId, attachments);
    if (entityLinks.length > 0) {
      await client.workItemEntityLink
        .createMany({ data: entityLinks, skipDuplicates: true })
        .catch(() => undefined);
    }
  }
}

export async function syncAttachments(
  client: {
    entityAttachment?: {
      deleteMany: (args: {
        where: Prisma.EntityAttachmentWhereInput;
      }) => Promise<unknown>;
      createMany: (args: {
        data: Prisma.EntityAttachmentCreateManyInput[];
      }) => Promise<unknown>;
    };
    workItemEntityLink?: {
      deleteMany: (args: {
        where: Prisma.WorkItemEntityLinkWhereInput;
      }) => Promise<unknown>;
      createMany: (args: {
        data: Prisma.WorkItemEntityLinkCreateManyInput[];
        skipDuplicates?: boolean;
      }) => Promise<unknown>;
    };
  },
  workItemId: string,
  projectId: string,
  authorId?: string,
  attachments?: WorkItemAttachments | Record<string, unknown>,
): Promise<void> {
  if (!client.entityAttachment) return;
  const records = buildAttachmentRecords(
    workItemId,
    projectId,
    authorId,
    attachments,
  );

  await client.entityAttachment.deleteMany({
    where: {
      entityType: EntityType.work_item,
      entityId: workItemId,
    },
  });

  if (records.length > 0) {
    await client.entityAttachment.createMany({ data: records });
  }

  if (client.workItemEntityLink?.deleteMany) {
    await client.workItemEntityLink
      .deleteMany({
        where: {
          workItemId,
          entityType: { in: [EntityType.page, EntityType.paper] },
        },
      })
      .catch(() => undefined);

    const entityLinks = extractEntityLinkInputs(workItemId, attachments);
    if (entityLinks.length > 0 && client.workItemEntityLink.createMany) {
      await client.workItemEntityLink
        .createMany({ data: entityLinks, skipDuplicates: true })
        .catch(() => undefined);
    }
  }
}
