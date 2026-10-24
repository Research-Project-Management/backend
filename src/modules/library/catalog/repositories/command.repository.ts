import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
  Inject,
  Optional,
} from '@nestjs/common';
import { Prisma, RelationType } from '@prisma/client';
import { PrismaService } from '@/core';
import { VersionMismatchException } from '@/modules/library/core/errors/version-mismatch.exception';
import {
  extractFileIdFromUrl,
  normalizeProjectScopeId,
} from '@/modules/library/core';
import { IStoragePort, STORAGE_PORT } from '@/modules/storage/storage.port';
import {
  CreateItemData,
  UpdateItemData,
} from '@/modules/library/core/types/bibliographic.types';
import {
  isUuid,
  cleanSingleIdentifier,
  normalizeItemIdentifiers,
  resolveExtraPlainText,
  extractNonColumnExtraFields,
  prepareNotesToCreate,
  resolveOrCreateTags,
  syncTagsForCatalogItem,
  buildCommandCreateInput,
  buildCommandUpdateInput,
  buildMyPublicationMetadata,
} from '@/modules/library/catalog/domain/command-payload.builder';
import { CommandBulkOperations } from './command-bulk.operations';
export {
  isUuid,
  cleanSingleIdentifier,
  normalizeItemIdentifiers,
  resolveExtraPlainText,
  extractNonColumnExtraFields,
  prepareNotesToCreate,
  resolveOrCreateTags,
  syncTagsForCatalogItem,
  buildCommandCreateInput,
  buildCommandUpdateInput,
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
    const { createData } = await buildCommandCreateInput(
      userId,
      data,
      client,
      normalizeProjectScopeId(projectId),
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
    const validProjectId = normalizeProjectScopeId(projectId);
    const scopeWhere: Prisma.ItemWhereInput =
      validProjectId && isUuid(validProjectId)
        ? { projectId: validProjectId }
        : { userId, projectId: null };
    const existing = await client.item.findFirst({
      where: {
        id,
        deletedAt: null,
        ...scopeWhere,
      },
      include: {
        notesList: { where: { deletedAt: null } },
      },
    });
    if (!existing) {
      throw new NotFoundException(`CatalogItem ${id} not found`);
    }
    if (expectedVersion !== undefined) {
      if (existing.version !== expectedVersion) {
        throw new VersionMismatchException({
          aggregateType: 'CatalogItem',
          entityId: id,
          currentVersion: existing.version,
          providedVersion: expectedVersion,
        });
      }
      const affected = await client.item.updateMany({
        where: {
          id,
          version: expectedVersion,
          deletedAt: null,
          ...scopeWhere,
        },
        data: {
          version: { increment: 1 },
        },
      });
      if (affected.count === 0) {
        const fresh = await client.item.findUnique({
          where: { id },
          select: { version: true },
        });
        throw new VersionMismatchException({
          aggregateType: 'CatalogItem',
          entityId: id,
          currentVersion: fresh?.version ?? existing.version,
          providedVersion: expectedVersion,
        });
      }
    }
    let sanitizedData = data;
    if (data.collectionIds !== undefined || data.collectionId !== undefined) {
      const candidateColIds = Array.from(
        new Set(
          [
            ...(Array.isArray(data.collectionIds) ? data.collectionIds : []),
            ...(data.collectionId && typeof data.collectionId === 'string'
              ? [data.collectionId.trim()]
              : []),
          ].filter(
            (cid): cid is string =>
              typeof cid === 'string' && cid.trim().length > 0,
          ),
        ),
      );
      if (candidateColIds.length > 0 && client.collection) {
        const targetProjectId = validProjectId ?? existing.projectId;
        const validCols = await client.collection.findMany({
          where: targetProjectId
            ? {
                id: { in: candidateColIds },
                projectId: targetProjectId,
                deletedAt: null,
              }
            : {
                id: { in: candidateColIds },
                userId,
                projectId: null,
                deletedAt: null,
              },
          select: { id: true },
        });
        if (Array.isArray(validCols)) {
          const validColSet = new Set(validCols.map((c) => c.id));
          sanitizedData = {
            ...data,
            ...(data.collectionIds !== undefined
              ? {
                  collectionIds: candidateColIds.filter((cid) =>
                    validColSet.has(cid),
                  ),
                }
              : {}),
            ...(data.collectionId !== undefined
              ? {
                  collectionId:
                    data.collectionId &&
                    validColSet.has(data.collectionId.trim())
                      ? data.collectionId.trim()
                      : null,
                }
              : {}),
          };
        }
      }
    }
    const { updateData, rawTags } = buildCommandUpdateInput(
      userId,
      existing,
      sanitizedData,
      { skipVersionIncrement: expectedVersion !== undefined },
    );
    const itemRelationsInclude = {
      collectionItems: {
        include: { collection: true },
      },
      itemTags: {
        include: { tag: true },
      },
      contributors: {
        orderBy: { orderIndex: 'asc' as const },
      },
      attachments: {
        include: { revisions: true },
      },
      notesList: {
        where: { deletedAt: null },
      },
    };
    const hasTagSync = Boolean(rawTags && Array.isArray(rawTags));
    const updated = await client.item.update({
      where: { id },
      data: updateData,
      ...(hasTagSync ? {} : { include: itemRelationsInclude }),
    });
    if (hasTagSync && rawTags) {
      await syncTagsForCatalogItem(
        client,
        userId,
        updated.id,
        rawTags,
        undefined,
        validProjectId ?? existing.projectId,
      );
      const reloaded = await client.item.findUnique({
        where: { id: updated.id },
        include: itemRelationsInclude,
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
    const validProjectId = normalizeProjectScopeId(projectId);
    const scopeWhere: Prisma.ItemWhereInput = {
      id,
      deletedAt: null,
      ...(validProjectId && isUuid(validProjectId)
        ? { projectId: validProjectId }
        : { userId, projectId: null }),
    };
    const deletedDate = new Date();
    if (expectedVersion !== undefined) {
      const result = await client.item.updateMany({
        where: {
          ...scopeWhere,
          version: expectedVersion,
        },
        data: {
          deletedAt: deletedDate,
          version: { increment: 1 },
        },
      });
      if (result.count === 0) {
        const existing = await client.item.findFirst({
          where: scopeWhere,
          select: { version: true },
        });
        if (existing && existing.version !== expectedVersion) {
          throw new VersionMismatchException({
            aggregateType: 'CatalogItem',
            entityId: id,
            currentVersion: existing.version,
            providedVersion: expectedVersion,
          });
        }
        return false;
      }
      await client.note?.updateMany?.({
        where: { itemId: id, deletedAt: null },
        data: { deletedAt: deletedDate },
      });
      return true;
    }
    const result = await client.item.updateMany({
      where: scopeWhere,
      data: {
        deletedAt: deletedDate,
        version: { increment: 1 },
      },
    });
    if (result.count > 0) {
      await client.note?.updateMany?.({
        where: { itemId: id, deletedAt: null },
        data: { deletedAt: deletedDate },
      });
    }
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
    const validProjectId = normalizeProjectScopeId(projectId);
    const scopeFilter: Prisma.ItemWhereInput = validProjectId
      ? { projectId: validProjectId }
      : { userId, projectId: null };
    const existing = await client.item.findFirst({
      where: {
        id,
        deletedAt: { not: null },
        ...scopeFilter,
      },
    });
    if (!existing) {
      throw new NotFoundException(`Trashed item ${id} not found`);
    }
    const metadataObj =
      existing.metadata &&
      typeof existing.metadata === 'object' &&
      !Array.isArray(existing.metadata)
        ? (existing.metadata as Record<string, unknown>)
        : {};
    if (
      typeof metadataObj.mergedIntoId === 'string' &&
      metadataObj.mergedIntoId
    ) {
      throw new BadRequestException(
        `Cannot restore item ${id}: it was merged into primary item ${metadataObj.mergedIntoId}`,
      );
    }
    if (expectedVersion !== undefined) {
      if (existing.version !== expectedVersion) {
        throw new VersionMismatchException({
          aggregateType: 'CatalogItem',
          entityId: id,
          currentVersion: existing.version,
          providedVersion: expectedVersion,
        });
      }
      const affected = await client.item.updateMany({
        where: {
          id,
          deletedAt: { not: null },
          version: expectedVersion,
          ...scopeFilter,
        },
        data: {
          version: { increment: 1 },
        },
      });
      if (affected.count === 0) {
        const fresh = await client.item.findUnique({
          where: { id },
          select: { version: true },
        });
        throw new VersionMismatchException({
          aggregateType: 'CatalogItem',
          entityId: id,
          currentVersion: fresh?.version ?? existing.version,
          providedVersion: expectedVersion,
        });
      }
    }
    await client.note?.updateMany?.({
      where: { itemId: id, deletedAt: { not: null } },
      data: { deletedAt: null },
    });
    await client.attachment.updateMany({
      where: { itemId: id, deletedAt: { not: null } },
      data: { deletedAt: null },
    });
    const itemAttachments = await client.attachment.findMany({
      where: { itemId: id },
      select: { id: true },
    });
    if (itemAttachments.length > 0) {
      await client.annotation.updateMany({
        where: {
          attachmentId: { in: itemAttachments.map((a) => a.id) },
          deletedAt: { not: null },
        },
        data: { deletedAt: null },
      });
    }
    const activeNoteCount = await client.note.count({
      where: { itemId: id, deletedAt: null },
    });
    const activeAttCount = await client.attachment.count({
      where: { itemId: id, deletedAt: null },
    });
    return client.item.update({
      where: { id },
      data: {
        deletedAt: null,
        noteCount: activeNoteCount,
        attachmentCount: activeAttCount,
        hasFile: activeAttCount > 0,
        ...(expectedVersion !== undefined ? {} : { version: { increment: 1 } }),
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
  private async collectStoragePathsForItems(
    client: Prisma.TransactionClient | PrismaService,
    itemIds: string[],
  ): Promise<string[]> {
    return CommandBulkOperations.collectStoragePathsForItems(client, itemIds);
  }
  async purge(
    userId: string,
    id: string,
    tx?: Prisma.TransactionClient,
    projectId?: string,
    options?: { skipStorageDelete?: boolean },
  ): Promise<boolean> {
    const res = await this.purgeWithStoragePaths(userId, id, tx, projectId, {
      skipStorageDelete: options?.skipStorageDelete ?? Boolean(tx),
    });
    return res.purged;
  }
  async purgeWithStoragePaths(
    userId: string,
    id: string,
    tx?: Prisma.TransactionClient,
    projectId?: string,
    options?: { skipStorageDelete?: boolean },
  ): Promise<{ purged: boolean; storagePaths: string[] }> {
    if (!isUuid(id) || !isUuid(userId)) {
      throw new NotFoundException(`Item ${id} not found`);
    }
    const client = this.getClient(tx);
    const validProjectId = normalizeProjectScopeId(projectId);
    const existing = await client.item.findFirst({
      where: {
        id,
        ...(validProjectId
          ? { projectId: validProjectId }
          : { userId, projectId: null }),
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
    const storagePaths = await this.collectStoragePathsForItems(client, [id]);
    await client.item.delete({
      where: { id },
    });
    if (storagePaths.length > 0 && !options?.skipStorageDelete) {
      await this.deleteStorageFilesBatch(storagePaths);
    }
    return { purged: true, storagePaths };
  }
  async softDeleteMany(
    userId: string,
    itemIds: string[],
    tx?: Prisma.TransactionClient,
    projectId?: string,
  ): Promise<{ succeededIds: string[]; failedIds: string[] }> {
    return CommandBulkOperations.softDeleteMany(
      this.getClient(tx),
      userId,
      itemIds,
      projectId,
    );
  }
  async restoreMany(
    userId: string,
    itemIds: string[],
    tx?: Prisma.TransactionClient,
    projectId?: string,
  ): Promise<{
    restoredItems: Array<{ id: string; version: number; projectId: string | null }>;
    succeededIds: string[];
    failedIds: string[];
  }> {
    return CommandBulkOperations.restoreMany(
      this.getClient(tx),
      userId,
      itemIds,
      projectId,
    );
  }
  async purgeMany(
    userId: string,
    itemIds: string[],
    tx?: Prisma.TransactionClient,
    projectId?: string,
  ): Promise<{
    succeededIds: string[];
    failedIds: string[];
    fileIdsToDelete: string[];
    storagePaths: string[];
  }> {
    return CommandBulkOperations.purgeMany(
      this.getClient(tx),
      userId,
      itemIds,
      projectId,
    );
  }
  async purgeExpiredTrash(
    retentionDays: number = 30,
    limit: number = 200,
    tx?: Prisma.TransactionClient,
  ): Promise<{
    purgedItems: number;
    purgedNotes: number;
    purgedCollections: number;
    storagePaths: string[];
  }> {
    const res = await CommandBulkOperations.purgeExpiredTrash(
      this.getClient(tx),
      retentionDays,
      limit,
    );
    if (!tx && res.storagePaths.length > 0) {
      await this.deleteStorageFilesBatch(res.storagePaths);
    }
    return res;
  }
  async deleteStorageFilesBatch(fileIds: string[]): Promise<void> {
    if (!this.storagePort?.deleteFile || fileIds.length === 0) return;
    const uniqueFileIds = Array.from(new Set(fileIds.filter(Boolean)));
    const results = await Promise.allSettled(
      uniqueFileIds.map((fileId) => this.storagePort!.deleteFile(fileId)),
    );
    results.forEach((res, idx) => {
      if (res.status === 'rejected') {
        const err = res.reason;
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `Failed to delete storage file ${uniqueFileIds[idx]} during item purge: ${message}`,
        );
      }
    });
  }
  async putRelation(
    itemId: string,
    relation: {
      targetItemId?: string;
      relationType?: string;
      description?: string;
    },
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const targetItemId = relation.targetItemId;
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
    const validRelationTypes = new Set<string>([
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
    const relationType: RelationType = validRelationTypes.has(rawType)
      ? (rawType as RelationType)
      : RelationType.related;
    const description = relation.description || '';
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
        description,
      },
      update: {
        description,
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
  }
  async setMyPublication(
    userId: string,
    id: string,
    isMyPublication: boolean,
    options?: {
      contributorId?: string | null;
      isPublic?: boolean;
      openAccessLicense?: string | null;
      includeAttachments?: boolean;
      includeNotes?: boolean;
      authorshipConfirmed?: boolean;
      projectId?: string;
    },
    tx?: Prisma.TransactionClient,
  ) {
    if (!isUuid(id) || !isUuid(userId)) {
      throw new NotFoundException(`CatalogItem ${id} not found`);
    }
    const validProjectId = normalizeProjectScopeId(options?.projectId);
    const scopeWhere = validProjectId
      ? { projectId: validProjectId }
      : { userId, projectId: null };
    const client = this.getClient(tx);
    const existing = await client.item.findFirst({
      where: { id, ...scopeWhere, deletedAt: null },
    });
    if (!existing) {
      throw new NotFoundException(`CatalogItem ${id} not found`);
    }
    if (isMyPublication) {
      const updatePayload = {
        ...(options?.contributorId !== undefined && { contributorId: options.contributorId }),
        ...(options?.isPublic !== undefined && { isPublic: options.isPublic }),
        ...(options?.openAccessLicense !== undefined && { openAccessLicense: options.openAccessLicense }),
      };
      await client.userPublication.upsert({
        where: { userId_itemId: { userId, itemId: id } },
        create: { userId, itemId: id, ...updatePayload },
        update: updatePayload,
      });
    } else {
      await client.userPublication.deleteMany({
        where: { userId, itemId: id },
      });
    }
    if (validProjectId) {
      return client.item.findUniqueOrThrow({
        where: { id },
        include: {
          collectionItems: { include: { collection: true } },
          itemTags: { include: { tag: true } },
          contributors: { orderBy: { orderIndex: 'asc' } },
          attachments: true,
        },
      });
    }
    const metadataObj = buildMyPublicationMetadata(existing.metadata, isMyPublication, options);
    return client.item.update({
      where: { id },
      data: {
        metadata: metadataObj as Prisma.InputJsonValue,
        version: { increment: 1 },
      },
      include: {
        collectionItems: { include: { collection: true } },
        itemTags: { include: { tag: true } },
        contributors: { orderBy: { orderIndex: 'asc' } },
        attachments: true,
      },
    });
  }
}
