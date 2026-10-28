import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
  Inject,
  Optional,
} from '@nestjs/common';
import {
  Prisma,
  RelationType,
  AttachmentExtractionStatus,
} from '@prisma/client';
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
  disambiguateCitationKey,
  syncCreatedIdentifiers,
  syncUpdatedIdentifiers,
} from '@/modules/library/catalog/domain/command-payload.builder';
import { CommandBulkOperations } from './command-bulk.operations';
import {
  sanitizeUpdateCollectionIds,
  putItemRelationInClient,
  removeItemRelationInClient,
  setMyPublicationInClient,
  buildCommandMutationInclude,
} from './command-relations.helper';
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
    const { createData, identifiersToCreate } = await buildCommandCreateInput(
      userId,
      data,
      client,
      normalizeProjectScopeId(projectId),
    );
    const item = await client.item.create({
      data: createData,
      include: {
        ...buildCommandMutationInclude(userId),
        attachments: true,
      },
    });
    if (
      identifiersToCreate.length > 0 &&
      (!Array.isArray(item.identifiers) || item.identifiers.length === 0)
    ) {
      await syncCreatedIdentifiers(client, item.id, identifiersToCreate);
      (item as Record<string, unknown>).identifiers = identifiersToCreate;
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
        contributors: { orderBy: { orderIndex: 'asc' } },
        identifiers: true,
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
    const sanitizedData = await sanitizeUpdateCollectionIds({
      client,
      userId,
      validProjectId,
      existingProjectId: existing.projectId,
      data,
    });
    const { updateData, cleanIds, rawTags } = buildCommandUpdateInput(
      userId,
      existing,
      sanitizedData,
      { skipVersionIncrement: expectedVersion !== undefined },
    );
    const createdAttachments = (updateData.attachments as { create?: unknown[] } | undefined)?.create;
    if (Array.isArray(createdAttachments) && createdAttachments.length > 0 && client.attachment?.count) {
      const existingAttCount = await client.attachment.count({
        where: { itemId: id, deletedAt: null },
      });
      const nextAttCount = existingAttCount + createdAttachments.length;
      updateData.attachmentCount = nextAttCount;
      updateData.hasFile = nextAttCount > 0;
    }
    const createdNotes = (updateData.notesList as { create?: unknown[] } | undefined)?.create;
    if (Array.isArray(createdNotes) && createdNotes.length > 0 && client.note?.count) {
      const existingNoteCount = await client.note.count({
        where: { itemId: id, deletedAt: null },
      });
      updateData.noteCount = existingNoteCount + createdNotes.length;
    }
    if (expectedVersion !== undefined) {
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
    await syncUpdatedIdentifiers(
      client,
      id,
      cleanIds,
      existing,
      (sanitizedData as { identifiers?: ReadonlyArray<{ type: string; value: string; canonicalUri?: string | null }> }).identifiers,
    );
    if (
      typeof updateData.citationKey === 'string' &&
      updateData.citationKey.trim() &&
      updateData.citationKey.trim().toLowerCase() !==
        (existing.citationKey ?? '').trim().toLowerCase()
    ) {
      updateData.citationKey = await disambiguateCitationKey(
        client,
        updateData.citationKey.trim(),
        { userId, projectId: validProjectId ?? existing.projectId },
        id,
      );
    }
    const itemRelationsInclude = buildCommandMutationInclude(userId, {
      includeAttachmentRevisions: true,
    });
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
      await Promise.all([
        client.note?.updateMany?.({
          where: { itemId: id, deletedAt: null },
          data: { deletedAt: deletedDate },
        }),
        client.attachment?.updateMany?.({
          where: { itemId: id, deletedAt: null },
          data: { deletedAt: deletedDate },
        }),
        client.annotation?.updateMany?.({
          where: { attachment: { itemId: id }, deletedAt: null },
          data: { deletedAt: deletedDate },
        }),
      ]);
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
      await Promise.all([
        client.note?.updateMany?.({
          where: { itemId: id, deletedAt: null },
          data: { deletedAt: deletedDate },
        }),
        client.attachment?.updateMany?.({
          where: { itemId: id, deletedAt: null },
          data: { deletedAt: deletedDate },
        }),
        client.annotation?.updateMany?.({
          where: { attachment: { itemId: id }, deletedAt: null },
          data: { deletedAt: deletedDate },
        }),
      ]);
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
    const deletedFilter = existing.deletedAt ? { gte: existing.deletedAt } : { not: null };

    await Promise.all([
      client.note?.updateMany?.({
        where: { itemId: id, deletedAt: deletedFilter },
        data: { deletedAt: null },
      }),
      client.attachment?.updateMany?.({
        where: { itemId: id, deletedAt: deletedFilter },
        data: { deletedAt: null },
      }),
      client.annotation?.updateMany?.({
        where: {
          attachment: { itemId: id },
          deletedAt: deletedFilter,
        },
        data: { deletedAt: null },
      }),
    ]);
    const [activeNoteCount, activeAttCount] = await Promise.all([
      client.note.count({
        where: { itemId: id, deletedAt: null },
      }),
      client.attachment.count({
        where: { itemId: id, deletedAt: null },
      }),
    ]);
    return client.item.update({
      where: { id },
      data: {
        deletedAt: null,
        noteCount: activeNoteCount,
        attachmentCount: activeAttCount,
        hasFile: activeAttCount > 0,
        ...(expectedVersion !== undefined ? {} : { version: { increment: 1 } }),
      },
      include: buildCommandMutationInclude(userId, {
        includeAttachmentRevisions: true,
        orderNotes: true,
      }),
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
    restoredItems: Array<{
      id: string;
      version: number;
      projectId: string | null;
    }>;
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
    expiredItems: Array<{
      id: string;
      userId: string;
      projectId: string | null;
    }>;
    expiredNotes: Array<{
      id: string;
      userId: string;
      projectId: string | null;
    }>;
    expiredCollections: Array<{
      id: string;
      userId: string;
      projectId: string | null;
    }>;
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
    return putItemRelationInClient(this.getClient(tx), itemId, relation);
  }
  async removeRelation(
    itemId: string,
    targetItemId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    return removeItemRelationInClient(this.getClient(tx), itemId, targetItemId);
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
    return setMyPublicationInClient(
      this.getClient(tx),
      userId,
      id,
      isMyPublication,
      options,
    );
  }
  async updateAttachmentProcessingStatus(
    attachmentId: string,
    status: string,
    currentMeta: Record<string, unknown>,
    metadataPatch?: Record<string, unknown>,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const client = this.getClient(tx);
    if (!client?.attachment?.update) return;
    const validStatuses = new Set<string>(
      Object.values(AttachmentExtractionStatus),
    );
    const normalizedUpper = status.toUpperCase();
    const isExtractionEnum = validStatuses.has(normalizedUpper);

    await client.attachment.update({
      where: { id: attachmentId },
      data: {
        ...(isExtractionEnum
          ? {
              extractionStatus:
                normalizedUpper as AttachmentExtractionStatus,
            }
          : {}),
        metadata: {
          ...currentMeta,
          extractionStatus: status,
          ...(metadataPatch ?? {}),
        } as Prisma.InputJsonValue,
      },
    });
  }
  async applyItemAiMetadataUpdate(params: {
    itemId: string;
    existing: Record<string, unknown>;
    filteredPatch: Record<string, unknown>;
    topLevelColumnSync: Record<string, unknown>;
    mergedMetadata: Prisma.InputJsonValue;
    tx?: Prisma.TransactionClient;
  }) {
    const {
      itemId,
      existing,
      filteredPatch,
      topLevelColumnSync,
      mergedMetadata,
      tx,
    } = params;
    const cleanAiIds = normalizeItemIdentifiers(filteredPatch, {
      preserveOnInvalid: true,
    });
    const itemRelationsInclude = {
      contributors: { orderBy: { orderIndex: 'asc' as const } },
      itemTags: { include: { tag: true } },
      collectionItems: { include: { collection: true } },
      attachments: { where: { deletedAt: null } },
      notesList: { where: { deletedAt: null } },
      identifiers: true,
    } satisfies Prisma.ItemInclude;

    const client = this.getClient(tx);
    const itemDelegate = client?.item ?? this.prisma?.item;
    const identClient = client?.itemIdentifier ? client : this.prisma;

    await syncUpdatedIdentifiers(identClient, itemId, cleanAiIds, existing);

    if (!itemDelegate?.update) return null;
    return itemDelegate.update({
      where: { id: itemId },
      data: {
        ...topLevelColumnSync,
        metadata: mergedMetadata,
        version: { increment: 1 },
      },
      include: itemRelationsInclude,
    });
  }
}
