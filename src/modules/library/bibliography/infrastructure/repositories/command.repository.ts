import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
  Inject,
  Optional,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../../core/database/prisma.service';
import { VersionMismatchException } from '../../../shared-kernel/core/errors/version-mismatch.exception';
import {
  IStoragePort,
  STORAGE_PORT,
} from '@/modules/storage/storage.port';
import { CreateItemData, UpdateItemData } from '../../domain/types/items.types';
import { isUUID } from 'class-validator';

import {
  isUuid,
  cleanSingleIdentifier,
  normalizeItemIdentifiers,
  unpackExtraFromDb,
  packExtraPayload,
  resolveExtraPlainText,
  extractNonColumnExtraFields,
  prepareNotesToCreate,
  resolveOrCreateTags,
  syncTagsForCatalogItem,
  buildCommandCreateInput,
  buildCommandUpdateInput,
  calculateIdentifierChanges,
} from '../mappers/command-payload.builder';

export {
  isUuid,
  cleanSingleIdentifier,
  normalizeItemIdentifiers,
  unpackExtraFromDb,
  packExtraPayload,
  resolveExtraPlainText,
  extractNonColumnExtraFields,
  prepareNotesToCreate,
  resolveOrCreateTags,
  syncTagsForCatalogItem,
  buildCommandCreateInput,
  buildCommandUpdateInput,
  calculateIdentifierChanges,
};

@Injectable()
export class CommandRepository {
  private readonly logger = new Logger(CommandRepository.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    @Inject(STORAGE_PORT)
    private readonly storagePort?: IStoragePort,
  ) {}

  private getClient(tx?: Prisma.TransactionClient) {
    return tx ?? this.prisma;
  }

  async create(
    userId: string,
    data: CreateItemData,
    tx?: Prisma.TransactionClient,
    projectId?: string,
  ) {
    const client = this.getClient(tx);
    const { createData, resolvedFileId } = await buildCommandCreateInput(
      userId,
      data,
      client,
      projectId,
    );

    const item = await client.item.create({
      data: createData,
      include: {
        collectionItems: {
          include: { collection: true },
        },
        itemTags: {
          include: { tag: true },
        },
        contributors: {
          orderBy: { orderIndex: 'asc' },
        },
        attachments: true,
        notesList: {
          where: { deletedAt: null },
        },
      },
    });

    if (resolvedFileId && (client as any).file?.updateMany) {
      await (client as any).file.updateMany({
        where: { id: resolvedFileId },
        data: {
          linkedToType: 'Paper',
          linkedToId: item.id,
        },
      });
    }
    return item;
  }

  async update(
    userId: string,
    id: string,
    expectedVersion: number | undefined,
    data: UpdateItemData,
    tx?: Prisma.TransactionClient,
    projectId?: string,
  ) {
    if (!isUuid(id) || !isUuid(userId)) {
      throw new NotFoundException(`CatalogItem ${id} not found`);
    }
    const client = this.getClient(tx);
    const existing = await client.item.findFirst({
      where: {
        id,
        deletedAt: null,
        ...(projectId && projectId !== 'user' && isUUID(projectId)
          ? { projectId }
          : { userId }),
      } as any,
      include: {
        notesList: { where: { deletedAt: null } },
      },
    });

    if (!existing) {
      throw new NotFoundException(`CatalogItem ${id} not found`);
    }

    if (expectedVersion !== undefined && existing.version !== expectedVersion) {
      throw new VersionMismatchException({
        aggregateType: 'CatalogItem',
        entityId: id,
        currentVersion: existing.version,
        providedVersion: expectedVersion,
      });
    }

    const { updateData, cleanIds, rawTags } = buildCommandUpdateInput(
      userId,
      existing,
      data,
    );

    const updated = await client.item.update({
      where: { id },
      data: updateData,
      include: {
        collectionItems: {
          include: { collection: true },
        },
        itemTags: {
          include: { tag: true },
        },
        contributors: {
          orderBy: { orderIndex: 'asc' },
        },
        attachments: {
          include: { revisions: true },
        },
        notesList: {
          where: { deletedAt: null },
        },
      },
    });

    if (rawTags && Array.isArray(rawTags)) {
      await syncTagsForCatalogItem(client, userId, updated.id, rawTags);

      const reloaded = await client.item.findUnique({
        where: { id: updated.id },
        include: {
          collectionItems: {
            include: { collection: true },
          },
          itemTags: {
            include: { tag: true },
          },
          contributors: {
            orderBy: { orderIndex: 'asc' },
          },
          attachments: {
            include: { revisions: true },
          },
          notesList: {
            where: { deletedAt: null },
          },
        },
      });
      return reloaded || updated;
    }

    return updated;
  }

  async softDelete(
    userId: string,
    id: string,
    expectedVersion?: number,
    tx?: Prisma.TransactionClient,
    projectId?: string,
  ): Promise<boolean> {
    if (!isUuid(id) || !isUuid(userId)) {
      return false;
    }
    const client = this.getClient(tx);
    const whereCondition: any = {
      id,
      deletedAt: null,
      ...(projectId && projectId !== 'user' ? { projectId } : { userId }),
    };
    if (expectedVersion !== undefined) {
      const existing = await client.item.findFirst({
        where: whereCondition,
      });
      if (existing && existing.version !== expectedVersion) {
        throw new VersionMismatchException({
          aggregateType: 'CatalogItem',
          entityId: id,
          currentVersion: existing.version,
          providedVersion: expectedVersion,
        });
      }
    }

    const result = await client.item.updateMany({
      where: whereCondition,
      data: { deletedAt: new Date() },
    });

    return result.count > 0;
  }

  async restore(
    userId: string,
    id: string,
    expectedVersion?: number,
    tx?: Prisma.TransactionClient,
    projectId?: string,
  ) {
    if (!isUuid(id) || !isUuid(userId)) {
      throw new NotFoundException(`Trashed item ${id} not found`);
    }
    const client = this.getClient(tx);
    const existing = await client.item.findFirst({
      where: {
        id,
        deletedAt: { not: null },
        ...(projectId && projectId !== 'user' ? { projectId } : { userId }),
      },
    });

    if (!existing) {
      throw new NotFoundException(`Trashed item ${id} not found`);
    }

    // Protection against restoring merged items
    const metadataObj: any = (existing.metadata as any) ?? {};

    if (metadataObj.mergedIntoId) {
      throw new BadRequestException(
        `Cannot restore item ${id}: it was merged into primary item ${metadataObj.mergedIntoId}`,
      );
    }

    if (expectedVersion !== undefined && existing.version !== expectedVersion) {
      throw new VersionMismatchException({
        aggregateType: 'CatalogItem',
        entityId: id,
        currentVersion: existing.version,
        providedVersion: expectedVersion,
      });
    }

    // Cascade restore associated notes, attachments, and annotations
    await client.note.updateMany({
      where: { itemId: id, deletedAt: { not: null } },
      data: { deletedAt: null },
    });

    const attachments = await client.attachment.findMany({
      where: { itemId: id },
      select: { id: true },
    });
    if (attachments.length > 0) {
      const attIds = attachments.map((a) => a.id);
      await client.attachment.updateMany({
        where: { id: { in: attIds }, deletedAt: { not: null } },
        data: { deletedAt: null },
      });
      await client.annotation.updateMany({
        where: { attachmentId: { in: attIds }, deletedAt: { not: null } },
        data: { deletedAt: null },
      });
    }

    return client.item.update({
      where: { id },
      data: {
        deletedAt: null,
        version: { increment: 1 },
      },
      include: {
        contributors: { orderBy: { orderIndex: 'asc' } },
        collectionItems: { include: { collection: true } },
        itemTags: { include: { tag: true } },
        notesList: { where: { deletedAt: null } },
        attachments: { include: { revisions: true } },
      },
    });
  }

  async purge(
    userId: string,
    id: string,
    tx?: Prisma.TransactionClient,
    projectId?: string,
  ): Promise<boolean> {
    if (!isUuid(id) || !isUuid(userId)) {
      throw new NotFoundException(`Item ${id} not found`);
    }
    const client = this.getClient(tx);
    const existing = await client.item.findFirst({
      where: {
        id,
        ...(projectId && projectId !== 'user' ? { projectId } : { userId }),
      },
    });

    if (!existing) {
      throw new NotFoundException(`Item ${id} not found`);
    }

    if (!existing.deletedAt) {
      throw new BadRequestException(
        `Item ${id} must be in trash before it can be permanently purged`,
      );
    }

    const attachments = await client.attachment.findMany({
      where: { itemId: id },
      select: { id: true, fileId: true, url: true },
    });

    for (const att of attachments) {
      const fileId =
        att.fileId ||
        att.url?.match(
          /\/api\/(?:v1\/(?:projects\/[^/]+\/)?library\/)?(?:attachments\/)?files\/([a-zA-Z0-9_-]+)/,
        )?.[1];
      if (fileId && this.storagePort?.deleteFile) {
        try {
          await this.storagePort.deleteFile(fileId);
        } catch (err: any) {
          this.logger.warn(
            `Failed to delete storage file ${fileId} during item purge: ${err?.message}`,
          );
        }
      }
    }

    await client.item.delete({
      where: { id },
    });

    return true;
  }

  async putRelation(
    itemId: string,
    relation: any,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const targetItemId = relation.targetItemId || relation.targetId;
    if (
      !targetItemId ||
      !isUuid(itemId) ||
      !isUuid(targetItemId) ||
      itemId === targetItemId
    ) {
      return;
    }
    const client = this.getClient(tx);

    const source = await client.item.findUnique({
      where: { id: itemId },
      select: { userId: true },
    });
    if (!source) return;

    const rawType = String(relation.relationType || '')
      .trim()
      .toLowerCase();
    const validRelationTypes = new Set([
      'cites',
      'cited_by',
      'replicates',
      'extends',
      'is_preprint_of',
      'is_published_version_of',
      'is_translation_of',
      'supplements',
      'related',
      'rebuts',
      'uses_dataset',
      'survey_of',
    ]);
    const relationType = validRelationTypes.has(rawType)
      ? (rawType as any)
      : 'related';

    await client.itemRelation.upsert({
      where: {
        sourceItemId_targetItemId_relationType: {
          sourceItemId: itemId,
          targetItemId,
          relationType,
        },
      },
      create: {
        sourceItemId: itemId,
        targetItemId,
        relationType,
        description: relation.description || '',
      },
      update: {
        description: relation.description || '',
      },
    });
  }

  async removeRelation(
    itemId: string,
    targetItemId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    if (!isUuid(itemId) || !isUuid(targetItemId)) return;
    const client = this.getClient(tx);
    await client.itemRelation.deleteMany({
      where: {
        OR: [
          { sourceItemId: itemId, targetItemId },
          { sourceItemId: targetItemId, targetItemId: itemId },
        ],
      },
    });

    const item = await client.item.findUnique({
      where: { id: itemId },
      select: { metadata: true },
    });
    if (item?.metadata) {
      try {
        const metadataObj: any = (item.metadata as any) ?? {};
        if (Array.isArray(metadataObj.relations)) {
          metadataObj.relations = metadataObj.relations.filter(
            (r: any) => (r.targetItemId || r.targetId) !== targetItemId,
          );
          await client.item.update({
            where: { id: itemId },
            data: { metadata: metadataObj },
          });
        }
      } catch (err: unknown) {
        this.logger.warn(
          `Failed to parse or sanitize relations JSON for item ${itemId}: ${(err as Error)?.message}`,
        );
      }
    }
  }

  async setMyPublication(
    userId: string,
    id: string,
    isMyPublication: boolean,
    tx?: Prisma.TransactionClient,
  ) {
    if (!isUuid(id) || !isUuid(userId)) {
      throw new NotFoundException(`CatalogItem ${id} not found`);
    }
    const client = this.getClient(tx);
    const existing = await client.item.findFirst({
      where: { id, userId, deletedAt: null },
    });

    if (!existing) {
      throw new NotFoundException(`CatalogItem ${id} not found`);
    }

    const metadataObj: any = (existing.metadata as any) ?? {};
    metadataObj.isMyPublication = isMyPublication;
    if (isMyPublication) {
      metadataObj.publicationConfirmedAt = new Date().toISOString();
      await client.userPublication.upsert({
        where: { userId_itemId: { userId, itemId: id } },
        create: { userId, itemId: id },
        update: {},
      });
    } else {
      await client.userPublication.deleteMany({
        where: { userId, itemId: id },
      });
    }

    return client.item.update({
      where: { id },
      data: {
        metadata: metadataObj,
        version: { increment: 1 },
      },
      include: {
        collectionItems: {
          include: { collection: true },
        },
        itemTags: {
          include: { tag: true },
        },
        contributors: {
          orderBy: { orderIndex: 'asc' },
        },
        attachments: true,
      },
    });
  }
}

export { CommandRepository as ItemCommandRepository };

