import { Injectable, NotFoundException, BadRequestException, Logger, Inject, Optional } from '@nestjs/common';
import { Prisma, AttachmentExtractionStatus, RelationType, TagType } from '@prisma/client';
import { PrismaService } from '@/core';
import { VersionMismatchException } from '@/modules/library/core/errors/domain.exception';
import { normalizeProjectScopeId, resolveSpaceId, syncItemDenormalizedCountsInClient } from '@/modules/library/core';
import { IStoragePort, STORAGE_PORT } from '@/modules/storage/storage.port';
import { CreateItemData, UpdateItemData } from '@/modules/library/core/types/bibliographic.types';
import {
  isUuid, cleanSingleIdentifier, normalizeItemIdentifiers, resolveExtraPlainText,
  extractNonColumnExtraFields, prepareNotesToCreate, buildCommandCreateInput, buildCommandUpdateInput,
} from '@/modules/library/catalog/domain/item-command.mapper';
import { CommandBulkOperations } from './command-bulk.operations';
import {
  resolveOrCreateTags, syncTagsForCatalogItem, disambiguateCitationKey, syncCreatedIdentifiers,
  syncUpdatedIdentifiers, resolveCreateItemRelations, sanitizeUpdateCollectionIds,
  putItemRelationInClient, removeItemRelationInClient, setMyPublicationInClient, buildCommandMutationInclude,
} from './command-relations.operations';
export {
  isUuid, cleanSingleIdentifier, normalizeItemIdentifiers, resolveExtraPlainText,
  extractNonColumnExtraFields, prepareNotesToCreate, resolveOrCreateTags,
  syncTagsForCatalogItem, buildCommandCreateInput, buildCommandUpdateInput,
};
@Injectable()
export class CommandRepository {
  private readonly logger = new Logger(CommandRepository.name);
  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(STORAGE_PORT) private readonly storagePort?: IStoragePort,
  ) {}
  private getClient(tx?: Prisma.TransactionClient) {
    return tx ?? this.prisma;
  }
  async syncItemAttachmentCounts(itemId: string, tx?: Prisma.TransactionClient): Promise<void> {
    if (!itemId || !isUuid(itemId)) return;
    await syncItemDenormalizedCountsInClient(this.getClient(tx), itemId, { attachments: true });
  }
  async syncItemNoteCount(itemId: string, tx?: Prisma.TransactionClient): Promise<void> {
    if (!itemId || !isUuid(itemId)) return;
    await syncItemDenormalizedCountsInClient(this.getClient(tx), itemId, { notes: true });
  }
  async create(userId: string, data: CreateItemData, tx?: Prisma.TransactionClient, projectId?: string) {
    const client = this.getClient(tx);
    const { createData, identifiersToCreate } = await resolveCreateItemRelations(
      client, userId, data, normalizeProjectScopeId(projectId),
    );
    const item = await client.libraryItem.create({
      data: createData,
      include: { ...buildCommandMutationInclude(userId), attachments: true },
    });
    if (identifiersToCreate.length > 0 && (!Array.isArray(item.identifiers) || item.identifiers.length === 0)) {
      await syncCreatedIdentifiers(client, item.id, identifiersToCreate);
      (item as Record<string, unknown>).identifiers = identifiersToCreate;
    }
    const validProjectId = normalizeProjectScopeId(projectId);
    const scopeWhere: Prisma.LibraryItemWhereInput = {
      spaceId: resolveSpaceId({ userId, projectId: validProjectId && isUuid(validProjectId) ? validProjectId : undefined }),
    };
    const existingAttIds = Array.isArray(data.attachments)
      ? data.attachments.map((a) => (a && typeof a.id === 'string' && isUuid(a.id) ? a.id : null)).filter((id): id is string => Boolean(id))
      : [];
    if (existingAttIds.length > 0 && typeof client.attachment?.updateMany === 'function') {
      const updatedAtts = await client.attachment.updateMany({
        where: { id: { in: existingAttIds }, deletedAt: null, item: scopeWhere },
        data: { itemId: item.id },
      });
      await syncItemDenormalizedCountsInClient(client, item.id, { attachments: true });
      const attachedCount = typeof updatedAtts?.count === 'number' ? updatedAtts.count : existingAttIds.length;
      if (attachedCount > 0) {
        (item as Record<string, unknown>).hasFile = true;
        if (typeof item.attachmentCount === 'number') {
          (item as Record<string, unknown>).attachmentCount = Math.max(item.attachmentCount, attachedCount);
        }
      }
    } else if (
      Array.isArray(item.attachments) && item.attachments.length > 0 &&
      (!item.hasFile || item.attachmentCount !== item.attachments.length)
    ) {
      await syncItemDenormalizedCountsInClient(client, item.id, { attachments: true });
      (item as Record<string, unknown>).hasFile = true;
      (item as Record<string, unknown>).attachmentCount = item.attachments.length;
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
    const scopeWhere: Prisma.LibraryItemWhereInput = {
      spaceId: resolveSpaceId({ userId, projectId: validProjectId && isUuid(validProjectId) ? validProjectId : undefined }),
    };
    const hasIncomingNotes = Array.isArray(data.notes) && data.notes.length > 0;
    const hasIncomingTags = Boolean(
      data.tags !== undefined ||
        data.keywords !== undefined ||
        data.labels !== undefined,
    );
    const existing = await client.libraryItem.findFirst({
      where: {
        id,
        deletedAt: null,
        ...scopeWhere,
      },
      include: {
        ...(hasIncomingNotes
          ? {
              notesList: {
                where: { deletedAt: null },
                select: { id: true, contentMd: true },
              },
            }
          : {}),
        ...(hasIncomingTags
          ? {
              itemTags: {
                include: { tag: true },
              },
            }
          : {}),
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
    const existingRec = existing as Record<string, unknown>;
    const existingProjectId =
      typeof existingRec.projectId === 'string'
        ? existingRec.projectId
        : existing.spaceId && existing.spaceId !== userId
          ? existing.spaceId
          : null;
    const sanitizedData = await sanitizeUpdateCollectionIds({
      client,
      userId,
      validProjectId,
      existingProjectId,
      data,
    });
    const { updateData, cleanIds, rawTags } = buildCommandUpdateInput(
      userId,
      existing,
      sanitizedData,
      { skipVersionIncrement: expectedVersion !== undefined },
    );
    const createdAttachments = (
      updateData.attachments as { create?: unknown[] } | undefined
    )?.create;
    const createdNotes = (
      updateData.notesList as { create?: unknown[] } | undefined
    )?.create;
    const needAttCount = Boolean(
      Array.isArray(createdAttachments) &&
      createdAttachments.length > 0 &&
      client.attachment?.count,
    );
    const needNoteCount = Boolean(
      Array.isArray(createdNotes) &&
      createdNotes.length > 0 &&
      client.libraryNote?.count,
    );
    if (needAttCount || needNoteCount) {
      const [existingAttCount, existingNoteCount] = await Promise.all([
        needAttCount
          ? client.attachment.count({ where: { itemId: id, deletedAt: null } })
          : Promise.resolve(0),
        needNoteCount
          ? client.libraryNote.count({ where: { itemId: id, deletedAt: null } })
          : Promise.resolve(0),
      ]);
      if (needAttCount && Array.isArray(createdAttachments)) {
        const nextAttCount = existingAttCount + createdAttachments.length;
        updateData.attachmentCount = nextAttCount;
        updateData.hasFile = nextAttCount > 0;
      }
      if (needNoteCount && Array.isArray(createdNotes)) {
        updateData.noteCount = existingNoteCount + createdNotes.length;
      }
    }
    if (expectedVersion !== undefined) {
      const affected = await client.libraryItem.updateMany({
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
        const fresh = await client.libraryItem.findUnique({
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
    const shouldDisambiguateKey =
      typeof updateData.citationKey === 'string' &&
      Boolean(updateData.citationKey.trim()) &&
      updateData.citationKey.trim().toLowerCase() !==
        (existing.citationKey ?? '').trim().toLowerCase();
    const [, disambiguatedKey] = await Promise.all([
      syncUpdatedIdentifiers(
        client,
        id,
        cleanIds,
        existing,
        (
          sanitizedData as {
            identifiers?: ReadonlyArray<{
              type: string;
              value: string;
              canonicalUri?: string | null;
            }>;
          }
        ).identifiers,
      ),
      shouldDisambiguateKey
        ? disambiguateCitationKey(
            client,
            (updateData.citationKey as string).trim(),
            { userId, projectId: validProjectId ?? existingProjectId },
            id,
          )
        : Promise.resolve(undefined),
    ]);
    if (shouldDisambiguateKey && disambiguatedKey !== undefined) {
      updateData.citationKey = disambiguatedKey;
    }
    const itemRelationsInclude = buildCommandMutationInclude(userId, {
      includeAttachmentRevisions: true,
    });
    const hasTagSync = Boolean(rawTags && Array.isArray(rawTags));
    const hasContributorReplace = Boolean(updateData.contributors);
    const savedUserPubContributors =
      hasContributorReplace && typeof client.userPublication?.findMany === 'function'
        ? await client.userPublication.findMany({
            where: { itemId: id, contributorId: { not: null } },
            include: { contributor: true },
          })
        : [];
    const updated = await client.libraryItem.update({
      where: { id },
      data: updateData,
      ...(hasTagSync
        ? hasContributorReplace
          ? { include: { contributors: { orderBy: { orderIndex: 'asc' as const } } } }
          : {}
        : { include: itemRelationsInclude }),
    });
    if (
      Array.isArray(savedUserPubContributors) &&
      savedUserPubContributors.length > 0 &&
      typeof client.userPublication?.update === 'function'
    ) {
      const updatedContributors = (
        Array.isArray((updated as unknown as { contributors?: unknown[] }).contributors)
          ? (updated as unknown as {
              contributors: Array<{
                id: string;
                orderIndex?: number | null;
                firstName?: string | null;
                lastName?: string | null;
                fullName?: string | null;
              }>;
            }).contributors
          : typeof client.contributor?.findMany === 'function'
            ? await client.contributor.findMany({
                where: { itemId: id },
                orderBy: { orderIndex: 'asc' },
              })
            : []
      ) || [];
      const normStr = (s?: string | null) => (s || '').trim().toLowerCase();
      for (const pub of savedUserPubContributors) {
        const oldContrib = pub.contributor;
        if (!oldContrib || updatedContributors.length === 0) continue;
        const matchedByName = updatedContributors.find(
          (nc) =>
            (normStr(oldContrib.lastName) &&
              normStr(nc.lastName) === normStr(oldContrib.lastName) &&
              normStr(nc.firstName) === normStr(oldContrib.firstName)) ||
            (normStr(oldContrib.fullName) &&
              normStr(nc.fullName) === normStr(oldContrib.fullName)),
        );
        const matchedByIndex = updatedContributors.find(
          (nc) => nc.orderIndex === oldContrib.orderIndex,
        );
        const matched = matchedByName ?? matchedByIndex;
        if (matched?.id) {
          await client.userPublication.update({
            where: {
              userId_itemId: { userId: pub.userId, itemId: pub.itemId },
            },
            data: { contributorId: matched.id },
          });
        }
      }
    }
    if (hasTagSync && rawTags) {
      const sanitizedRecord = sanitizedData as Record<string, unknown>;
      const isSystemTagUpdate =
        Boolean(sanitizedRecord.__isSystemUpdate) ||
        typeof sanitizedRecord.__updateSource === 'string';
      const existingItemTags = Array.isArray(
        (existing as { itemTags?: unknown[] }).itemTags,
      )
        ? ((
            existing as {
              itemTags: Array<{
                tagId?: string;
                type?: TagType;
                tag?: { id?: string; name?: string; type?: TagType };
              }>;
            }
          ).itemTags)
        : undefined;
      await syncTagsForCatalogItem(
        client,
        userId,
        updated.id,
        rawTags,
        isSystemTagUpdate ? TagType.automatic : TagType.manual,
        validProjectId ?? existingProjectId,
        existingItemTags,
      );
      const reloaded = await client.libraryItem.findUnique({
        where: { id: updated.id },
        include: itemRelationsInclude,
      });
      return reloaded || updated;
    }
    return updated;
  }
  private async cascadeSoftDeleteItemChildren(
    client: Prisma.TransactionClient | PrismaService, itemId: string, deletedDate: Date,
  ): Promise<void> {
    await Promise.all([
      client.libraryNote?.updateMany?.({ where: { itemId, deletedAt: null }, data: { deletedAt: deletedDate } }),
      client.attachment?.updateMany?.({ where: { itemId, deletedAt: null }, data: { deletedAt: deletedDate } }),
      client.annotation?.updateMany?.({
        where: { attachment: { itemId }, deletedAt: null },
        data: { deletedAt: deletedDate },
      }),
    ]);
  }
  async softDelete(
    userId: string, id: string, expectedVersion?: number, tx?: Prisma.TransactionClient, projectId?: string,
  ): Promise<boolean> {
    if (!isUuid(id) || !isUuid(userId)) return false;
    const client = this.getClient(tx);
    const validProjectId = normalizeProjectScopeId(projectId);
    const scopeWhere: Prisma.LibraryItemWhereInput = {
      id, deletedAt: null,
      spaceId: resolveSpaceId({ userId, projectId: validProjectId && isUuid(validProjectId) ? validProjectId : undefined }),
    };
    const deletedDate = new Date();
    if (expectedVersion !== undefined) {
      const result = await client.libraryItem.updateMany({
        where: { ...scopeWhere, version: expectedVersion },
        data: {
          deletedAt: deletedDate,
          deletedById: userId,
          noteCount: 0,
          attachmentCount: 0,
          hasFile: false,
          version: { increment: 1 },
        },
      });
      if (result.count === 0) {
        const existing = await client.libraryItem.findFirst({ where: scopeWhere, select: { version: true } });
        if (existing && existing.version !== expectedVersion) {
          throw new VersionMismatchException({
            aggregateType: 'CatalogItem', entityId: id, currentVersion: existing.version, providedVersion: expectedVersion,
          });
        }
        return false;
      }
      await this.cascadeSoftDeleteItemChildren(client, id, deletedDate);
      return true;
    }
    const result = await client.libraryItem.updateMany({
      where: scopeWhere,
      data: {
        deletedAt: deletedDate,
        deletedById: userId,
        noteCount: 0,
        attachmentCount: 0,
        hasFile: false,
        version: { increment: 1 },
      },
    });
    if (result.count > 0) await this.cascadeSoftDeleteItemChildren(client, id, deletedDate);
    return result.count > 0;
  }
  async restore(
    userId: string, id: string, expectedVersion?: number, tx?: Prisma.TransactionClient, projectId?: string,
  ) {
    if (!isUuid(id) || !isUuid(userId)) throw new NotFoundException(`Trashed item ${id} not found`);
    const client = this.getClient(tx);
    const validProjectId = normalizeProjectScopeId(projectId);
    const scopeFilter: Prisma.LibraryItemWhereInput = {
      spaceId: resolveSpaceId({ userId, projectId: validProjectId }),
    };
    const existing = await client.libraryItem.findFirst({
      where: { id, deletedAt: { not: null }, ...scopeFilter },
    });
    if (!existing) throw new NotFoundException(`Trashed item ${id} not found`);
    const metadataObj =
      existing.metadata && typeof existing.metadata === 'object' && !Array.isArray(existing.metadata)
        ? { ...(existing.metadata as Record<string, unknown>) }
        : {};
    let cleanedMetadata: Prisma.InputJsonValue | undefined;
    if (typeof metadataObj.mergedIntoId === 'string' && metadataObj.mergedIntoId) {
      delete metadataObj.mergedIntoId;
      delete metadataObj.mergedAt;
      cleanedMetadata = metadataObj as Prisma.InputJsonValue;
    }
    if (expectedVersion !== undefined) {
      if (existing.version !== expectedVersion) {
        throw new VersionMismatchException({
          aggregateType: 'CatalogItem', entityId: id, currentVersion: existing.version, providedVersion: expectedVersion,
        });
      }
    }
    const deletedFilter = existing.deletedAt ? { gte: existing.deletedAt } : { not: null };

    await Promise.all([
      client.libraryNote?.updateMany?.({ where: { itemId: id, deletedAt: deletedFilter }, data: { deletedAt: null } }),
      client.attachment?.updateMany?.({ where: { itemId: id, deletedAt: deletedFilter }, data: { deletedAt: null } }),
      client.annotation?.updateMany?.({
        where: { attachment: { itemId: id }, deletedAt: deletedFilter },
        data: { deletedAt: null },
      }),
    ]);
    const [activeNoteCount, activeAttCount] = await Promise.all([
      client.libraryNote.count({ where: { itemId: id, deletedAt: null } }),
      client.attachment.count({ where: { itemId: id, deletedAt: null } }),
    ]);
    if (expectedVersion !== undefined && typeof client.libraryItem.updateMany === 'function') {
      const affected = await client.libraryItem.updateMany({
        where: { id, deletedAt: { not: null }, version: expectedVersion, ...scopeFilter },
        data: {
          deletedAt: null, deletedById: null, updatedById: userId,
          noteCount: activeNoteCount, attachmentCount: activeAttCount, hasFile: activeAttCount > 0,
          ...(cleanedMetadata !== undefined ? { metadata: cleanedMetadata } : {}),
          version: { increment: 1 },
        },
      });
      if (affected.count === 0) {
        const fresh = await client.libraryItem.findUnique({ where: { id }, select: { version: true } });
        throw new VersionMismatchException({
          aggregateType: 'CatalogItem', entityId: id, currentVersion: fresh?.version ?? existing.version, providedVersion: expectedVersion,
        });
      }
      if (typeof client.libraryItem.findUnique === 'function') {
        const reloaded = await client.libraryItem.findUnique({
          where: { id },
          include: buildCommandMutationInclude(userId, { includeAttachmentRevisions: true, orderNotes: true }),
        });
        if (reloaded) return reloaded;
      }
    }
    return client.libraryItem.update({
      where: { id },
      data: {
        deletedAt: null, deletedById: null, updatedById: userId,
        noteCount: activeNoteCount, attachmentCount: activeAttCount, hasFile: activeAttCount > 0,
        ...(cleanedMetadata !== undefined ? { metadata: cleanedMetadata } : {}),
        version: { increment: 1 },
      },
      include: buildCommandMutationInclude(userId, { includeAttachmentRevisions: true, orderNotes: true }),
    });
  }
  private async collectStoragePathsForItems(
    client: Prisma.TransactionClient | PrismaService, itemIds: string[],
  ): Promise<string[]> {
    return CommandBulkOperations.collectStoragePathsForItems(client, itemIds);
  }
  async purge(
    userId: string, id: string, tx?: Prisma.TransactionClient, projectId?: string, options?: { skipStorageDelete?: boolean },
  ): Promise<boolean> {
    const res = await this.purgeWithStoragePaths(userId, id, tx, projectId, {
      skipStorageDelete: options?.skipStorageDelete ?? Boolean(tx),
    });
    return res.purged;
  }
  async purgeWithStoragePaths(
    userId: string, id: string, tx?: Prisma.TransactionClient, projectId?: string, options?: { skipStorageDelete?: boolean },
  ): Promise<{ purged: boolean; storagePaths: string[] }> {
    if (!isUuid(id) || !isUuid(userId)) throw new NotFoundException(`Item ${id} not found`);
    const client = this.getClient(tx);
    const validProjectId = normalizeProjectScopeId(projectId);
    const existing = await client.libraryItem.findFirst({
      where: { id, spaceId: resolveSpaceId({ userId, projectId: validProjectId }) },
    });
    if (!existing) throw new NotFoundException(`Item ${id} not found`);
    if (!existing.deletedAt) {
      throw new BadRequestException(`Item ${id} must be in trash before it can be permanently purged`);
    }
    const storagePaths = await this.collectStoragePathsForItems(client, [id]);
    await client.libraryItem.delete({ where: { id } });
    if (storagePaths.length > 0 && !options?.skipStorageDelete) {
      await this.deleteStorageFilesBatch(storagePaths);
    }
    return { purged: true, storagePaths };
  }
  async softDeleteMany(userId: string, itemIds: string[], tx?: Prisma.TransactionClient, projectId?: string) {
    return CommandBulkOperations.softDeleteMany(this.getClient(tx), userId, itemIds, projectId);
  }
  async restoreMany(userId: string, itemIds: string[], tx?: Prisma.TransactionClient, projectId?: string) {
    return CommandBulkOperations.restoreMany(this.getClient(tx), userId, itemIds, projectId);
  }
  async purgeMany(userId: string, itemIds: string[], tx?: Prisma.TransactionClient, projectId?: string) {
    return CommandBulkOperations.purgeMany(this.getClient(tx), userId, itemIds, projectId);
  }
  async emptyTrash(userId: string, tx?: Prisma.TransactionClient, projectId?: string) {
    return CommandBulkOperations.emptyTrash(this.getClient(tx), userId, projectId);
  }
  async purgeExpiredTrash(retentionDays: number = 30, limit: number = 200, tx?: Prisma.TransactionClient) {
    const res = await CommandBulkOperations.purgeExpiredTrash(this.getClient(tx), retentionDays, limit);
    if (!tx && res.storagePaths.length > 0) await this.deleteStorageFilesBatch(res.storagePaths);
    return res;
  }
  async deleteStorageFilesBatch(fileIds: string[]): Promise<void> {
    if (!this.storagePort?.deleteFile || fileIds.length === 0) return;
    const uniqueFileIds = Array.from(new Set(fileIds.filter(Boolean)));
    const results = await Promise.allSettled(uniqueFileIds.map((fileId) => this.storagePort!.deleteFile(fileId)));
    results.forEach((res, idx) => {
      if (res.status === 'rejected') {
        const err = res.reason;
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Failed to delete storage file ${uniqueFileIds[idx]} during item purge: ${message}`);
      }
    });
  }
  async putRelation(
    itemId: string,
    relation: { targetItemId?: string; relationType?: string; description?: string },
    tx?: Prisma.TransactionClient,
  ): Promise<{ id: string } | undefined> {
    return putItemRelationInClient(this.getClient(tx), itemId, relation);
  }
  async removeRelation(
    itemId: string, targetItemId: string, tx?: Prisma.TransactionClient, relationType?: RelationType,
  ): Promise<void> {
    return removeItemRelationInClient(this.getClient(tx), itemId, targetItemId, relationType);
  }
  async setMyPublication(
    userId: string,
    id: string,
    isMyPublication: boolean,
    options?: {
      contributorId?: string | null; isPublic?: boolean; openAccessLicense?: string | null;
      includeAttachments?: boolean; includeNotes?: boolean; authorshipConfirmed?: boolean; projectId?: string;
    },
    tx?: Prisma.TransactionClient,
  ) {
    return setMyPublicationInClient(this.getClient(tx), userId, id, isMyPublication, options);
  }
  async updateAttachmentProcessingStatus(
    attachmentId: string, status: string, currentMeta: Record<string, unknown>,
    metadataPatch?: Record<string, unknown>, tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const client = this.getClient(tx);
    if (!client?.attachment?.update) return;
    const validStatuses = new Set<string>(Object.values(AttachmentExtractionStatus));
    const normalizedUpper = status.toUpperCase();
    const isExtractionEnum = validStatuses.has(normalizedUpper);

    await client.attachment.update({
      where: { id: attachmentId },
      data: {
        ...(isExtractionEnum ? { extractionStatus: normalizedUpper as AttachmentExtractionStatus } : {}),
        metadata: { ...currentMeta, extractionStatus: status, ...(metadataPatch ?? {}) },
      },
    });
  }
  async applyItemAiMetadataUpdate(params: {
    itemId: string;
    mergedMetadata: Prisma.InputJsonValue;
    tx?: Prisma.TransactionClient;
  }) {
    const { itemId, mergedMetadata, tx } = params;
    const itemRelationsInclude = {
      contributors: { orderBy: { orderIndex: 'asc' as const } },
      itemTags: { include: { tag: true } },
      collectionItems: { include: { collection: true } },
      attachments: { where: { deletedAt: null } },
      notesList: { where: { deletedAt: null } },
      identifiers: true,
    } satisfies Prisma.LibraryItemInclude;

    const client = this.getClient(tx);
    const itemDelegate = client?.libraryItem ?? this.prisma?.libraryItem;
    if (!itemDelegate?.update) return null;
    return itemDelegate.update({
      where: { id: itemId },
      data: { metadata: mergedMetadata, version: { increment: 1 } },
      include: itemRelationsInclude,
    });
  }
}
