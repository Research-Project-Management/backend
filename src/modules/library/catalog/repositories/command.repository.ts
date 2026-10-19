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
} from '@/modules/library/catalog/domain/command-payload.builder';

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

    const { updateData, rawTags } = buildCommandUpdateInput(
      userId,
      existing,
      data,
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

    if (expectedVersion !== undefined) {
      const result = await client.item.updateMany({
        where: {
          ...scopeWhere,
          version: expectedVersion,
        },
        data: {
          deletedAt: new Date(),
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
      return true;
    }

    const result = await client.item.updateMany({
      where: scopeWhere,
      data: {
        deletedAt: new Date(),
        version: { increment: 1 },
      },
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

    const activeNoteCount = await client.note.count({
      where: { itemId: id, deletedAt: null },
    });

    return client.item.update({
      where: { id },
      data: {
        deletedAt: null,
        noteCount: activeNoteCount,
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
    if (itemIds.length === 0) return [];
    const paths = new Set<string>();

    const attachments = await client.attachment.findMany({
      where: { itemId: { in: itemIds } },
      select: { id: true, fileId: true, url: true },
    });
    const attachmentIds: string[] = [];
    for (const att of attachments) {
      if (att.id) attachmentIds.push(att.id);
      const fileId = att.fileId || extractFileIdFromUrl(att.url);
      if (fileId) paths.add(fileId);
    }

    if (
      attachmentIds.length > 0 &&
      typeof client.attachmentRevision?.findMany === 'function'
    ) {
      const revisions = await client.attachmentRevision.findMany({
        where: { attachmentId: { in: attachmentIds } },
        select: { fileId: true, url: true },
      });
      for (const rev of revisions) {
        const fileId = rev.fileId || extractFileIdFromUrl(rev.url);
        if (fileId) paths.add(fileId);
      }
    }

    if (typeof client.itemMetadata?.findMany === 'function') {
      const metadataRecords = await client.itemMetadata.findMany({
        where: { itemId: { in: itemIds } },
        select: { rawPayload: true },
      });
      for (const rec of metadataRecords) {
        const raw = rec.rawPayload as
          | (Record<string, unknown> & {
              isOffloaded?: boolean;
              fileId?: string;
            })
          | null;
        if (raw?.isOffloaded && typeof raw.fileId === 'string' && raw.fileId) {
          paths.add(raw.fileId);
        }
      }
    }

    return Array.from(paths);
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

    if (storagePaths.length > 0) {
      await this.deleteStorageFilesBatch(storagePaths);
    }

    return true;
  }

  async softDeleteMany(
    userId: string,
    itemIds: string[],
    tx?: Prisma.TransactionClient,
    projectId?: string,
  ): Promise<{ succeededIds: string[]; failedIds: string[] }> {
    const validUserId = isUuid(userId);
    const validIds = Array.from(
      new Set(itemIds.filter((id) => isUuid(id))),
    );
    if (!validUserId || validIds.length === 0) {
      return { succeededIds: [], failedIds: [...itemIds] };
    }

    const client = this.getClient(tx);
    const validProjectId = normalizeProjectScopeId(projectId);
    const scopeFilter: Prisma.ItemWhereInput =
      validProjectId && isUuid(validProjectId)
        ? { projectId: validProjectId }
        : { userId, projectId: null };

    const existingItems = await client.item.findMany({
      where: {
        id: { in: validIds },
        deletedAt: null,
        ...scopeFilter,
      },
      select: { id: true },
    });

    const foundSet = new Set(existingItems.map((it) => it.id));
    const succeededIds = itemIds.filter((id, idx) => foundSet.has(id) && itemIds.indexOf(id) === idx);
    const failedIds = itemIds.filter((id, idx) => !foundSet.has(id) || itemIds.indexOf(id) !== idx);

    if (succeededIds.length > 0) {
      const deletedAt = new Date();
      await client.item.updateMany({
        where: {
          id: { in: succeededIds },
          deletedAt: null,
          ...scopeFilter,
        },
        data: {
          deletedAt,
          version: { increment: 1 },
        },
      });
    }

    return { succeededIds, failedIds };
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
    const validUserId = isUuid(userId);
    const validIds = Array.from(
      new Set(itemIds.filter((id) => isUuid(id))),
    );
    if (!validUserId || validIds.length === 0) {
      return { restoredItems: [], succeededIds: [], failedIds: [...itemIds] };
    }

    const client = this.getClient(tx);
    const validProjectId = normalizeProjectScopeId(projectId);
    const scopeFilter: Prisma.ItemWhereInput = validProjectId
      ? { projectId: validProjectId }
      : { userId, projectId: null };

    const existingItems = await client.item.findMany({
      where: {
        id: { in: validIds },
        deletedAt: { not: null },
        ...scopeFilter,
      },
      select: { id: true, version: true, projectId: true, metadata: true },
    });

    const restorableMap = new Map<
      string,
      { id: string; version: number; projectId: string | null }
    >();
    for (const item of existingItems) {
      const metadataObj =
        item.metadata &&
        typeof item.metadata === 'object' &&
        !Array.isArray(item.metadata)
          ? (item.metadata as Record<string, unknown>)
          : {};
      if (
        typeof metadataObj.mergedIntoId === 'string' &&
        metadataObj.mergedIntoId
      ) {
        continue;
      }
      restorableMap.set(item.id, {
        id: item.id,
        version: item.version + 1,
        projectId: item.projectId,
      });
    }

    const succeededIds = itemIds.filter(
      (id, idx) => restorableMap.has(id) && itemIds.indexOf(id) === idx,
    );
    const failedIds = itemIds.filter(
      (id, idx) => !restorableMap.has(id) || itemIds.indexOf(id) !== idx,
    );

    if (succeededIds.length > 0) {
      await client.item.updateMany({
        where: {
          id: { in: succeededIds },
          deletedAt: { not: null },
          ...scopeFilter,
        },
        data: {
          deletedAt: null,
          version: { increment: 1 },
        },
      });
    }

    const restoredItems = succeededIds
      .map((id) => restorableMap.get(id)!)
      .filter(Boolean);

    return { restoredItems, succeededIds, failedIds };
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
    const validUserId = isUuid(userId);
    const validIds = Array.from(
      new Set(itemIds.filter((id) => isUuid(id))),
    );
    if (!validUserId || validIds.length === 0) {
      return {
        succeededIds: [],
        failedIds: [...itemIds],
        fileIdsToDelete: [],
        storagePaths: [],
      };
    }

    const client = this.getClient(tx);
    const validProjectId = normalizeProjectScopeId(projectId);
    const scopeFilter: Prisma.ItemWhereInput = validProjectId
      ? { projectId: validProjectId }
      : { userId, projectId: null };

    const existingItems = await client.item.findMany({
      where: {
        id: { in: validIds },
        deletedAt: { not: null },
        ...scopeFilter,
      },
      select: { id: true },
    });

    const purgeableSet = new Set(existingItems.map((it) => it.id));
    const succeededIds = itemIds.filter(
      (id, idx) => purgeableSet.has(id) && itemIds.indexOf(id) === idx,
    );
    const failedIds = itemIds.filter(
      (id, idx) => !purgeableSet.has(id) || itemIds.indexOf(id) !== idx,
    );

    let storagePaths: string[] = [];
    if (succeededIds.length > 0) {
      storagePaths = await this.collectStoragePathsForItems(
        client,
        succeededIds,
      );

      await client.item.deleteMany({
        where: {
          id: { in: succeededIds },
          ...scopeFilter,
        },
      });
    }

    return {
      succeededIds,
      failedIds,
      fileIdsToDelete: storagePaths,
      storagePaths,
    };
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
    const client = this.getClient(tx);
    const cutoff = new Date(Date.now() - retentionDays * 86400 * 1000);

    const expiredItems = await client.item.findMany({
      where: { deletedAt: { lt: cutoff } },
      select: { id: true },
      orderBy: { deletedAt: 'asc' },
      take: limit,
    });
    const expiredItemIds = expiredItems.map((it) => it.id);

    let storagePaths: string[] = [];
    let purgedItems = 0;
    if (expiredItemIds.length > 0) {
      storagePaths = await this.collectStoragePathsForItems(
        client,
        expiredItemIds,
      );
      const delItems = await client.item.deleteMany({
        where: { id: { in: expiredItemIds } },
      });
      purgedItems = delItems.count;
    }

    const expiredNotes = await client.note.findMany({
      where: { deletedAt: { lt: cutoff } },
      select: { id: true },
      orderBy: { deletedAt: 'asc' },
      take: limit,
    });
    let purgedNotes = 0;
    if (expiredNotes.length > 0) {
      const delNotes = await client.note.deleteMany({
        where: { id: { in: expiredNotes.map((n) => n.id) } },
      });
      purgedNotes = delNotes.count;
    }

    const expiredCollections = await client.collection.findMany({
      where: { deletedAt: { lt: cutoff } },
      select: { id: true },
      orderBy: { deletedAt: 'asc' },
      take: limit,
    });
    let purgedCollections = 0;
    if (expiredCollections.length > 0) {
      const delCollections = await client.collection.deleteMany({
        where: { id: { in: expiredCollections.map((c) => c.id) } },
      });
      purgedCollections = delCollections.count;
    }

    if (storagePaths.length > 0) {
      await this.deleteStorageFilesBatch(storagePaths);
    }

    return {
      purgedItems,
      purgedNotes,
      purgedCollections,
      storagePaths,
    };
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

    const metadataObj: Record<string, unknown> =
      typeof existing.metadata === 'object' &&
      existing.metadata !== null &&
      !Array.isArray(existing.metadata)
        ? { ...(existing.metadata as Record<string, unknown>) }
        : {};
    metadataObj.isMyPublication = isMyPublication;
    if (isMyPublication) {
      metadataObj.publicationConfirmedAt = new Date().toISOString();
      if (options?.openAccessLicense !== undefined) {
        metadataObj.openAccessLicense = options.openAccessLicense;
      }
      if (options?.isPublic !== undefined) {
        metadataObj.isPublicPublication = options.isPublic;
      }
      if (options?.contributorId !== undefined) {
        metadataObj.publicationContributorId = options.contributorId;
      }
      if (options?.includeAttachments !== undefined) {
        metadataObj.includeAttachmentsInMyPublications =
          options.includeAttachments;
      }
      if (options?.includeNotes !== undefined) {
        metadataObj.includeNotesInMyPublications = options.includeNotes;
      }
      if (options?.authorshipConfirmed !== undefined) {
        metadataObj.authorshipConfirmed = options.authorshipConfirmed;
      }

      const createPayload: {
        userId: string;
        itemId: string;
        contributorId?: string | null;
        isPublic?: boolean;
        openAccessLicense?: string | null;
      } = {
        userId,
        itemId: id,
        ...(options?.contributorId !== undefined && {
          contributorId: options.contributorId,
        }),
        ...(options?.isPublic !== undefined && { isPublic: options.isPublic }),
        ...(options?.openAccessLicense !== undefined && {
          openAccessLicense: options.openAccessLicense,
        }),
      };

      const updatePayload: {
        contributorId?: string | null;
        isPublic?: boolean;
        openAccessLicense?: string | null;
      } = {
        ...(options?.contributorId !== undefined && {
          contributorId: options.contributorId,
        }),
        ...(options?.isPublic !== undefined && { isPublic: options.isPublic }),
        ...(options?.openAccessLicense !== undefined && {
          openAccessLicense: options.openAccessLicense,
        }),
      };

      await client.userPublication.upsert({
        where: { userId_itemId: { userId, itemId: id } },
        create: createPayload,
        update: updatePayload,
      });
    } else {
      await client.userPublication.deleteMany({
        where: { userId, itemId: id },
      });
    }

    return client.item.update({
      where: { id },
      data: {
        metadata: metadataObj as Prisma.InputJsonValue,
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
