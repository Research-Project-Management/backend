import { Injectable, Logger, Inject } from '@nestjs/common';
import { PrismaService } from '../../../core/database/prisma.service';
import { ZoteroConnectionService } from './zotero-connection.service';
import { ZoteroConnector } from './zotero.connector';
import { ZoteroMapper } from './zotero.mapper';
import {
  LIBRARY_SYNC_PORT,
  ILibrarySyncPort,
  ExternalSyncOperation,
} from '../../library/sync/library-sync.port';

export interface PullJobResult {
  syncRunId: string;
  itemsCreated: number;
  itemsUpdated: number;
  collectionsCreated: number;
  versionAfter: bigint;
}

@Injectable()
export class ZoteroPullWorker {
  private readonly logger = new Logger(ZoteroPullWorker.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly connectionService: ZoteroConnectionService,
    private readonly connector: ZoteroConnector,
    private readonly mapper: ZoteroMapper,
    @Inject(LIBRARY_SYNC_PORT)
    private readonly libraryBridge: ILibrarySyncPort,
  ) {}

  /**
   * Executes an initial or incremental pull for a Zotero remote library binding.
   * Granularity:
   * - Collections delta processed as an atomic Library batch.
   * - Each page of Items delta processed as an atomic Library batch via applyExternalSyncBatch.
   * - Checkpoint (lastSyncVersion) advances ONLY after all pages complete successfully.
   */
  async executePull(
    workspaceId: string,
    bindingId: string,
    batchLimit = 50,
  ): Promise<PullJobResult> {
    const binding = await this.prisma.zoteroBinding.findUnique({
      where: { id: bindingId },
      include: { connection: true },
    });

    if (!binding || binding.workspaceId !== workspaceId) {
      throw new Error(
        `Zotero binding ${bindingId} not found in workspace ${workspaceId}`,
      );
    }

    if (binding.connection.status !== 'active') {
      throw new Error(
        `Zotero connection ${binding.connectionId} is ${binding.connection.status}`,
      );
    }

    const apiKey = await this.connectionService.getDecryptedApiKey(
      binding.connectionId,
      workspaceId,
    );

    // 1. Create SyncRun audit record
    const syncRun = await this.prisma.zoteroSyncRun.create({
      data: {
        bindingId,
        workspaceId,
        direction: 'pull',
        status: 'running',
        versionBefore: binding.lastSyncVersion,
      },
    });

    const isInitial = binding.lastSyncVersion === BigInt(0);
    const effectiveSinceVersion = isInitial
      ? undefined
      : binding.lastSyncVersion;

    let totalItemsCreated = 0;
    let totalItemsUpdated = 0;
    let totalCollectionsCreated = 0;
    let latestVersionSeen = binding.lastSyncVersion;

    try {
      // 2. Process Collections delta in an atomic batch
      const collectionsRes = await this.connector.pullCollections(
        apiKey,
        binding.remoteLibraryType as 'user' | 'group',
        binding.remoteLibraryId,
        effectiveSinceVersion,
      );

      if (collectionsRes.version > latestVersionSeen) {
        latestVersionSeen = collectionsRes.version;
      }

      if (collectionsRes.collections.length > 0) {
        const createdCount = await this.syncCollectionsBatch(
          workspaceId,
          bindingId,
          binding.connection.userId,
          collectionsRes.collections,
          collectionsRes.version,
        );
        totalCollectionsCreated += createdCount;
      }

      // 3. Process Items delta page by page, each page in an atomic Library batch
      let itemStart = 0;
      let hasMoreItems = true;
      let pageIndex = 0;

      while (hasMoreItems) {
        const itemsRes = await this.connector.pullItems(
          apiKey,
          binding.remoteLibraryType as 'user' | 'group',
          binding.remoteLibraryId,
          {
            sinceVersion: effectiveSinceVersion,
            start: itemStart,
            limit: batchLimit,
          },
        );

        if (itemsRes.version > latestVersionSeen) {
          latestVersionSeen = itemsRes.version;
        }

        if (itemsRes.items.length > 0) {
          const { created, updated } = await this.syncItemsPageBatch(
            workspaceId,
            bindingId,
            binding.connection.userId,
            itemsRes.items,
            itemsRes.version,
            pageIndex,
          );
          totalItemsCreated += created;
          totalItemsUpdated += updated;
        }

        itemStart += itemsRes.items.length;
        pageIndex++;

        if (
          itemsRes.items.length < batchLimit ||
          itemStart >= itemsRes.totalResults
        ) {
          hasMoreItems = false;
        }
      }

      // 4. Advance binding checkpoint ONLY after all pages succeeded
      await this.prisma.zoteroBinding.update({
        where: { id: bindingId },
        data: {
          lastSyncVersion: latestVersionSeen,
          lastSyncAt: new Date(),
        },
      });

      // 5. Complete SyncRun record
      await this.prisma.zoteroSyncRun.update({
        where: { id: syncRun.id },
        data: {
          status: 'completed',
          versionAfter: latestVersionSeen,
          itemsCreated: totalItemsCreated,
          itemsUpdated: totalItemsUpdated,
          completedAt: new Date(),
        },
      });

      this.logger.log(
        `Zotero pull completed for binding ${bindingId}: created=${totalItemsCreated}, updated=${totalItemsUpdated}, collections=${totalCollectionsCreated}, version=${latestVersionSeen}`,
      );

      return {
        syncRunId: syncRun.id,
        itemsCreated: totalItemsCreated,
        itemsUpdated: totalItemsUpdated,
        collectionsCreated: totalCollectionsCreated,
        versionAfter: latestVersionSeen,
      };
    } catch (err: any) {
      this.logger.error(
        `Zotero pull failed for binding ${bindingId}: ${err.message}`,
        err.stack,
      );

      await this.prisma.zoteroSyncRun.update({
        where: { id: syncRun.id },
        data: {
          status: 'failed',
          errorMessage: err.message,
          completedAt: new Date(),
        },
      });

      await this.prisma.zoteroSyncFailure.create({
        data: {
          bindingId,
          workspaceId,
          syncRunId: syncRun.id,
          operation: 'pull',
          errorMessage: err.message,
          errorDetails: { stack: err.stack },
        },
      });

      await this.prisma.zoteroBinding.update({
        where: { id: bindingId },
        data: {
          lastSyncAt: new Date(),
        },
      });

      throw err;
    }
  }

  /**
   * Syncs a batch of Collections via applyExternalSyncBatch in 1 Library transaction.
   */
  private async syncCollectionsBatch(
    workspaceId: string,
    bindingId: string,
    userId: string,
    rawCollections: any[],
    remoteVersion: bigint,
  ): Promise<number> {
    const colKeys = rawCollections.map((c) => c.key);

    // Batch load existing bindings (no N+1)
    const existingBindings = await this.prisma.zoteroItemBinding.findMany({
      where: {
        bindingId,
        remoteKey: { in: colKeys },
      },
    });
    const bindingMap = new Map(existingBindings.map((b) => [b.remoteKey, b]));

    const operations: ExternalSyncOperation[] = rawCollections.map((rawCol) => {
      const mapped = this.mapper.mapZoteroCollection(rawCol);
      const existing = bindingMap.get(mapped.remoteKey);

      return {
        operationId: `col:${mapped.remoteKey}`,
        op: 'upsertCollection',
        parentRef: mapped.parentRemoteKey
          ? `col:${mapped.parentRemoteKey}`
          : undefined,
        command: {
          workspaceId,
          userId,
          existingId: existing?.entityId,
          name: mapped.name,
        },
      };
    });

    const idempotencyKey = `zotero:pull:${workspaceId}:${bindingId}:cols:v${remoteVersion}`;

    const batchRes = await this.libraryBridge.applyExternalSyncBatch({
      workspaceId,
      idempotencyKey,
      operations,
    });

    let collectionsCreated = 0;

    for (const opRes of batchRes.results) {
      if (opRes.result && opRes.operationId) {
        const remoteKey = opRes.operationId.replace(/^col:/, '');
        const rawCol = rawCollections.find((c) => c.key === remoteKey);
        const mapped = rawCol ? this.mapper.mapZoteroCollection(rawCol) : null;

        if (mapped) {
          await this.prisma.zoteroItemBinding.upsert({
            where: {
              bindingId_remoteKey: {
                bindingId,
                remoteKey,
              },
            },
            create: {
              bindingId,
              workspaceId,
              entityType: 'collection',
              entityId: opRes.result.id,
              remoteKey,
              remoteVersion: mapped.remoteVersion,
              rawPayload: mapped.rawPayload as any,
              syncState: 'synced',
            },
            update: {
              remoteVersion: mapped.remoteVersion,
              rawPayload: mapped.rawPayload as any,
              syncState: 'synced',
            },
          });

          const isExisting = bindingMap.has(remoteKey);
          if (!isExisting && opRes.result.isNew) {
            collectionsCreated++;
          }
        }
      }
    }

    return collectionsCreated;
  }

  /**
   * Syncs a single page of items (top-level, attachments, notes, annotations)
   * in 1 atomic Library transaction via applyExternalSyncBatch.
   */
  private async syncItemsPageBatch(
    workspaceId: string,
    bindingId: string,
    userId: string,
    rawItems: any[],
    remoteVersion: bigint,
    pageIndex: number,
  ): Promise<{ created: number; updated: number }> {
    const itemKeys = rawItems.map((i) => i.key);

    // 1. Batch load existing item bindings for this page (no N+1)
    const existingBindings = await this.prisma.zoteroItemBinding.findMany({
      where: {
        bindingId,
        remoteKey: { in: itemKeys },
      },
    });
    const bindingMap = new Map(existingBindings.map((b) => [b.remoteKey, b]));

    // 2. Fetch parent bindings for any child items whose parent was synced in a previous page
    const parentKeysToFetch = rawItems
      .map((i) => i.data?.parentItem)
      .filter((k): k is string => Boolean(k) && !bindingMap.has(k));

    if (parentKeysToFetch.length > 0) {
      const parentBindings = await this.prisma.zoteroItemBinding.findMany({
        where: {
          bindingId,
          remoteKey: { in: parentKeysToFetch },
        },
      });
      for (const pb of parentBindings) {
        bindingMap.set(pb.remoteKey, pb);
      }
    }

    const operations: ExternalSyncOperation[] = [];

    // Top-level Catalog Items
    for (const rawItem of rawItems) {
      const itemType = rawItem.data?.itemType;
      if (
        itemType !== 'attachment' &&
        itemType !== 'note' &&
        itemType !== 'annotation'
      ) {
        const mapped = this.mapper.mapZoteroItem(rawItem);
        const existing = bindingMap.get(mapped.remoteKey);

        operations.push({
          operationId: `item:${mapped.remoteKey}`,
          op: 'upsertCatalogItem',
          command: {
            workspaceId,
            userId,
            existingId: existing?.entityId,
            title: mapped.title,
            abstract: mapped.abstract,
            year: mapped.year,
            doi: mapped.doi,
            citationKey: mapped.citationKey,
            publicationTitle: mapped.publicationTitle,
            volume: mapped.volume,
            issue: mapped.issue,
            pages: mapped.pages,
            issn: mapped.issn,
            isbn: mapped.isbn,
            url: mapped.url,
            itemType: mapped.itemType,
            filename: `${mapped.remoteKey}.pdf`,
            fileUrl:
              mapped.url || `https://api.zotero.org/items/${mapped.remoteKey}`,
            tags: mapped.tags.map((t) => t.name).filter(Boolean),
          },
        });
      }
    }

    // Attachments (referencing parent item in same batch or previous page)
    for (const rawItem of rawItems) {
      if (rawItem.data?.itemType === 'attachment') {
        const mapped = this.mapper.mapZoteroAttachment(rawItem);
        const existing = bindingMap.get(mapped.remoteKey);
        const parentBinding = mapped.parentItemKey
          ? bindingMap.get(mapped.parentItemKey)
          : undefined;

        operations.push({
          operationId: `att:${mapped.remoteKey}`,
          op: 'upsertAttachment',
          parentRef: mapped.parentItemKey
            ? `item:${mapped.parentItemKey}`
            : undefined,
          command: {
            workspaceId,
            existingId: existing?.entityId,
            catalogItemId: parentBinding?.entityId,
            filename: mapped.filename,
            url:
              mapped.url ||
              `https://api.zotero.org/items/${mapped.remoteKey}/file`,
            mimeType: mapped.mimeType,
            fileHash: mapped.fileHash,
            attachmentType: mapped.attachmentType,
            size: 0,
          },
        });
      }
    }

    // Notes (referencing parent item in same batch or previous page)
    for (const rawItem of rawItems) {
      if (rawItem.data?.itemType === 'note') {
        const mapped = this.mapper.mapZoteroNote(rawItem);
        const existing = bindingMap.get(mapped.remoteKey);
        const parentBinding = mapped.parentItemKey
          ? bindingMap.get(mapped.parentItemKey)
          : undefined;

        operations.push({
          operationId: `note:${mapped.remoteKey}`,
          op: 'upsertNote',
          parentRef: mapped.parentItemKey
            ? `item:${mapped.parentItemKey}`
            : undefined,
          command: {
            workspaceId,
            userId,
            existingId: existing?.entityId,
            catalogItemId: parentBinding?.entityId,
            title: 'Zotero Note',
            contentMd: mapped.contentHtml,
            tags: mapped.tags || [],
          },
        });
      }
    }

    // Annotations (referencing parent attachment in same batch or previous page)
    for (const rawItem of rawItems) {
      if (rawItem.data?.itemType === 'annotation') {
        const mapped = this.mapper.mapZoteroAnnotation(rawItem);
        const existing = bindingMap.get(mapped.remoteKey);
        const parentAttBinding = mapped.parentAttachmentKey
          ? bindingMap.get(mapped.parentAttachmentKey)
          : undefined;

        operations.push({
          operationId: `ann:${mapped.remoteKey}`,
          op: 'upsertAnnotation',
          parentRef: mapped.parentAttachmentKey
            ? `att:${mapped.parentAttachmentKey}`
            : undefined,
          command: {
            workspaceId,
            userId,
            existingId: existing?.entityId,
            attachmentId: parentAttBinding?.entityId,
            pageIndex: mapped.pageIndex,
            quoteText: mapped.quote,
            comment: mapped.comment,
            color: mapped.color,
            type: mapped.annotationType,
          },
        });
      }
    }

    const idempotencyKey = `zotero:pull:${workspaceId}:${bindingId}:items:v${remoteVersion}:p${pageIndex}`;

    // 3. Execute in 1 atomic Library transaction
    const batchRes = await this.libraryBridge.applyExternalSyncBatch({
      workspaceId,
      idempotencyKey,
      operations,
    });

    let itemsCreated = 0;
    let itemsUpdated = 0;

    // 4. Batch-upsert Zotero Item Bindings from batch results
    for (const opRes of batchRes.results) {
      if (opRes.result && opRes.operationId) {
        const [prefix, remoteKey] = opRes.operationId.split(':');
        const rawItem = rawItems.find((i) => i.key === remoteKey);

        if (rawItem) {
          let entityType = 'item';
          let mapped: any;

          if (prefix === 'item') {
            entityType = 'item';
            mapped = this.mapper.mapZoteroItem(rawItem);
            const isExisting = bindingMap.has(remoteKey);
            if (!isExisting && opRes.result.isNew) itemsCreated++;
            else itemsUpdated++;
          } else if (prefix === 'att') {
            entityType = 'attachment';
            mapped = this.mapper.mapZoteroAttachment(rawItem);
          } else if (prefix === 'note') {
            entityType = 'note';
            mapped = this.mapper.mapZoteroNote(rawItem);
          } else if (prefix === 'ann') {
            entityType = 'annotation';
            mapped = this.mapper.mapZoteroAnnotation(rawItem);
          }

          if (mapped) {
            await this.prisma.zoteroItemBinding.upsert({
              where: {
                bindingId_remoteKey: {
                  bindingId,
                  remoteKey,
                },
              },
              create: {
                bindingId,
                workspaceId,
                entityType,
                entityId: opRes.result.id,
                remoteKey,
                remoteVersion: mapped.remoteVersion,
                rawPayload: mapped.rawPayload,
                syncState: 'synced',
              },
              update: {
                remoteVersion: mapped.remoteVersion,
                rawPayload: mapped.rawPayload,
                syncState: 'synced',
              },
            });
          }
        }
      }
    }

    return { created: itemsCreated, updated: itemsUpdated };
  }
}
