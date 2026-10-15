import { Injectable } from '@nestjs/common';
import { Prisma, EntityType } from '@prisma/client';
import { WorkItemAttachments } from '@/modules/work-item/core/types/work-item.types';

@Injectable()
export class AttachmentSyncHandler {
  buildAttachmentRecords(
    workItemId: string,
    projectId: string,
    authorId?: string,
    attachments?: WorkItemAttachments | Record<string, unknown>,
  ): Prisma.EntityAttachmentCreateManyInput[] {
    if (!attachments || typeof attachments !== 'object') {
      return [];
    }

    const records: Prisma.EntityAttachmentCreateManyInput[] = [];

    if (Array.isArray(attachments.pages)) {
      for (const p of attachments.pages) {
        const pageId = p?.pageId || p?.id;
        if (pageId) {
          records.push({
            entityType: EntityType.work_item,
            entityId: workItemId,
            projectId,
            authorId,
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

    if (Array.isArray(attachments.papers)) {
      for (const p of attachments.papers) {
        const paperId = p?.paperId || p?.id;
        if (paperId) {
          records.push({
            entityType: EntityType.work_item,
            entityId: workItemId,
            projectId,
            authorId,
            filename: p.title || 'Untitled Paper',
            url: p.doi ? `https://doi.org/${p.doi}` : '',
            mimeType: 'application/x-paper',
            size: 0,
            metadata: {
              category: 'paper',
              paperId,
              title: p.title,
              doi: p.doi,
              citationKey: p.citationKey,
            },
          });
        }
      }
    }

    if (Array.isArray(attachments.files)) {
      for (const f of attachments.files) {
        if (f?.url) {
          records.push({
            entityType: EntityType.work_item,
            entityId: workItemId,
            projectId,
            authorId,
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

    if (Array.isArray(attachments.links)) {
      for (const l of attachments.links) {
        if (l?.url) {
          records.push({
            entityType: EntityType.work_item,
            entityId: workItemId,
            projectId,
            authorId,
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

  async saveInitialAttachments(
    client: {
      entityAttachment?: {
        createMany: (args: {
          data: Prisma.EntityAttachmentCreateManyInput[];
        }) => Promise<unknown>;
      };
    },
    workItemId: string,
    projectId: string,
    authorId: string,
    attachments?: WorkItemAttachments | Record<string, unknown>,
  ): Promise<void> {
    if (!client.entityAttachment) return;
    const records = this.buildAttachmentRecords(
      workItemId,
      projectId,
      authorId,
      attachments,
    );
    if (records.length > 0) {
      await client.entityAttachment.createMany({ data: records });
    }
  }

  async syncAttachments(
    client: {
      entityAttachment?: {
        deleteMany: (args: {
          where: Prisma.EntityAttachmentWhereInput;
        }) => Promise<unknown>;
        createMany: (args: {
          data: Prisma.EntityAttachmentCreateManyInput[];
        }) => Promise<unknown>;
      };
    },
    workItemId: string,
    projectId: string,
    authorId?: string,
    attachments?: WorkItemAttachments | Record<string, unknown>,
  ): Promise<void> {
    if (!client.entityAttachment) return;
    const records = this.buildAttachmentRecords(
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
  }
}
