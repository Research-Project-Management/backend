import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../../core/database/prisma.service';
import { ZoteroConnectionService } from './zotero-connection.service';
import { ZoteroConnector } from './zotero.connector';
import { ZoteroMapper } from './zotero.mapper';
import { LibraryTransactionService } from '../../sync-core/library-transaction.service';

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
    private readonly txService: LibraryTransactionService,
  ) {}

  /**
   * Executes an initial or incremental pull for a Zotero remote library binding.
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

    const apiKey = await this.connectionService.getDecryptedApiKey(
      binding.connectionId,
      workspaceId,
    );

    const versionBefore = binding.lastSyncVersion;
    let highestVersion = versionBefore;
    let itemsCreated = 0;
    let itemsUpdated = 0;
    let collectionsCreated = 0;

    // Create SyncRun record
    const syncRun = await this.prisma.zoteroSyncRun.create({
      data: {
        bindingId,
        workspaceId,
        direction: 'pull',
        versionBefore,
        status: 'running',
      },
    });

    try {
      // 1. Pull Collections
      const colResult = await this.connector.pullCollections(
        apiKey,
        binding.remoteLibraryType as 'user' | 'group',
        binding.remoteLibraryId,
        versionBefore,
      );

      if (colResult.version > highestVersion) {
        highestVersion = colResult.version;
      }

      for (const rawCol of colResult.collections) {
        const isNew = await this.processCollection(
          workspaceId,
          bindingId,
          binding.connection.userId,
          rawCol,
        );
        if (isNew) collectionsCreated++;
      }

      // 2. Pull Items with pagination
      let start = 0;
      let totalResults = 1;

      while (start < totalResults) {
        const pullRes = await this.connector.pullItems(
          apiKey,
          binding.remoteLibraryType as 'user' | 'group',
          binding.remoteLibraryId,
          {
            sinceVersion: versionBefore,
            start,
            limit: batchLimit,
          },
        );

        totalResults = pullRes.totalResults;
        if (pullRes.version > highestVersion) {
          highestVersion = pullRes.version;
        }

        if (pullRes.items.length === 0) {
          break;
        }

        // Process batch items atomically
        for (const rawItem of pullRes.items) {
          const itemType = rawItem.data?.itemType || rawItem.itemType;

          if (itemType === 'attachment') {
            await this.processAttachment(workspaceId, bindingId, rawItem);
          } else if (itemType === 'note') {
            await this.processNote(
              workspaceId,
              bindingId,
              binding.connection.userId,
              rawItem,
            );
          } else if (itemType === 'annotation') {
            await this.processAnnotation(
              workspaceId,
              bindingId,
              binding.connection.userId,
              rawItem,
            );
          } else {
            const isNew = await this.processCatalogItem(
              workspaceId,
              bindingId,
              binding.connection.userId,
              rawItem,
            );
            if (isNew) itemsCreated++;
            else itemsUpdated++;
          }
        }

        start += pullRes.items.length;
      }

      // Update binding sync status & version
      await this.prisma.zoteroBinding.update({
        where: { id: bindingId },
        data: {
          lastSyncVersion: highestVersion,
          lastSyncAt: new Date(),
          syncStatus: 'idle',
        },
      });

      // Update SyncRun
      await this.prisma.zoteroSyncRun.update({
        where: { id: syncRun.id },
        data: {
          status: 'completed',
          versionAfter: highestVersion,
          itemsCreated,
          itemsUpdated,
          completedAt: new Date(),
        },
      });

      return {
        syncRunId: syncRun.id,
        itemsCreated,
        itemsUpdated,
        collectionsCreated,
        versionAfter: highestVersion,
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
          syncRunId: syncRun.id,
          bindingId,
          workspaceId,
          operation: 'pull_items',
          errorMessage: err.message,
        },
      });

      await this.prisma.zoteroBinding.update({
        where: { id: bindingId },
        data: { syncStatus: 'error' },
      });

      throw err;
    }
  }

  private async processCollection(
    workspaceId: string,
    bindingId: string,
    userId: string,
    rawCol: any,
  ): Promise<boolean> {
    const mapped = this.mapper.mapZoteroCollection(rawCol);

    const existingBinding = await this.prisma.zoteroItemBinding.findUnique({
      where: {
        bindingId_remoteKey: {
          bindingId,
          remoteKey: mapped.remoteKey,
        },
      },
    });

    let isNew = false;
    let collectionId: string;

    await this.txService.executeInTransaction(async (tx, helpers) => {
      if (existingBinding) {
        collectionId = existingBinding.entityId;
        await tx.collection.update({
          where: { id: collectionId },
          data: { name: mapped.name },
        });

        await helpers.appendChange(workspaceId, {
          entityType: 'Collection',
          entityId: collectionId,
          action: 'update',
          version: 2,
          data: { name: mapped.name },
        });
      } else {
        isNew = true;
        const created = await tx.collection.create({
          data: {
            workspaceId,
            name: mapped.name,
            createdById: userId,
          },
        });
        collectionId = created.id;

        await helpers.appendChange(workspaceId, {
          entityType: 'Collection',
          entityId: collectionId,
          action: 'create',
          version: 1,
          data: { name: mapped.name },
        });

        await helpers.publishOutbox(
          workspaceId,
          collectionId,
          'library.zotero.collection_synced',
          { collectionId, remoteKey: mapped.remoteKey },
        );
      }

      await tx.zoteroItemBinding.upsert({
        where: {
          bindingId_remoteKey: {
            bindingId,
            remoteKey: mapped.remoteKey,
          },
        },
        create: {
          bindingId,
          workspaceId,
          entityType: 'collection',
          entityId: collectionId,
          remoteKey: mapped.remoteKey,
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
    });

    return isNew;
  }

  private async processCatalogItem(
    workspaceId: string,
    bindingId: string,
    userId: string,
    rawItem: any,
  ): Promise<boolean> {
    const mapped = this.mapper.mapZoteroItem(rawItem);

    const existingBinding = await this.prisma.zoteroItemBinding.findUnique({
      where: {
        bindingId_remoteKey: {
          bindingId,
          remoteKey: mapped.remoteKey,
        },
      },
    });

    let isNew = false;
    let itemId: string;

    await this.txService.executeInTransaction(async (tx, helpers) => {
      if (existingBinding) {
        itemId = existingBinding.entityId;
        await tx.catalogItem.update({
          where: { id: itemId },
          data: {
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
            version: { increment: 1 },
          },
        });

        await helpers.appendChange(workspaceId, {
          entityType: 'CatalogItem',
          entityId: itemId,
          action: 'update',
          version: 2,
          data: { title: mapped.title },
        });
      } else {
        isNew = true;
        const created = await tx.catalogItem.create({
          data: {
            workspaceId,
            uploadedById: userId,
            filename: `${mapped.remoteKey}.pdf`,
            fileUrl:
              mapped.url || `https://api.zotero.org/items/${mapped.remoteKey}`,
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
            version: 1,
          },
        });
        itemId = created.id;

        await helpers.appendChange(workspaceId, {
          entityType: 'CatalogItem',
          entityId: itemId,
          action: 'create',
          version: 1,
          data: { title: mapped.title },
        });

        await helpers.publishOutbox(
          workspaceId,
          itemId,
          'library.zotero.item_synced',
          { itemId, remoteKey: mapped.remoteKey },
        );
      }

      // Upsert remote binding
      await tx.zoteroItemBinding.upsert({
        where: {
          bindingId_remoteKey: {
            bindingId,
            remoteKey: mapped.remoteKey,
          },
        },
        create: {
          bindingId,
          workspaceId,
          entityType: 'item',
          entityId: itemId,
          remoteKey: mapped.remoteKey,
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
    });

    return isNew;
  }

  private async processAttachment(
    workspaceId: string,
    bindingId: string,
    rawAttachment: any,
  ): Promise<void> {
    const mapped = this.mapper.mapZoteroAttachment(rawAttachment);

    // Find parent item binding
    const parentBinding = await this.prisma.zoteroItemBinding.findUnique({
      where: {
        bindingId_remoteKey: {
          bindingId,
          remoteKey: mapped.parentItemKey,
        },
      },
    });

    if (!parentBinding) {
      return; // Skip orphan attachments until parent item exists
    }

    const existingBinding = await this.prisma.zoteroItemBinding.findUnique({
      where: {
        bindingId_remoteKey: {
          bindingId,
          remoteKey: mapped.remoteKey,
        },
      },
    });

    let attachmentId: string;
    await this.txService.executeInTransaction(async (tx, helpers) => {
      if (existingBinding) {
        attachmentId = existingBinding.entityId;
        await tx.catalogAttachment.update({
          where: { id: attachmentId },
          data: {
            filename: mapped.filename,
            url: mapped.url || '',
            mimeType: mapped.mimeType,
            fileHash: mapped.fileHash,
          },
        });

        await helpers.appendChange(workspaceId, {
          entityType: 'CatalogAttachment',
          entityId: attachmentId,
          action: 'update',
          version: 2,
        });
      } else {
        const created = await tx.catalogAttachment.create({
          data: {
            catalogItemId: parentBinding.entityId,
            filename: mapped.filename,
            url:
              mapped.url ||
              `https://api.zotero.org/items/${mapped.remoteKey}/file`,
            mimeType: mapped.mimeType,
            fileHash: mapped.fileHash,
            attachmentType: (mapped.attachmentType as any) || 'primary_pdf',
            size: 0,
          },
        });
        attachmentId = created.id;

        await helpers.appendChange(workspaceId, {
          entityType: 'CatalogAttachment',
          entityId: attachmentId,
          action: 'create',
          version: 1,
        });

        await helpers.publishOutbox(
          workspaceId,
          attachmentId,
          'library.zotero.attachment_synced',
          { attachmentId, remoteKey: mapped.remoteKey },
        );
      }

      await tx.zoteroItemBinding.upsert({
        where: {
          bindingId_remoteKey: {
            bindingId,
            remoteKey: mapped.remoteKey,
          },
        },
        create: {
          bindingId,
          workspaceId,
          entityType: 'attachment',
          entityId: attachmentId,
          remoteKey: mapped.remoteKey,
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
    });
  }

  private async processNote(
    workspaceId: string,
    bindingId: string,
    userId: string,
    rawNote: any,
  ): Promise<void> {
    const mapped = this.mapper.mapZoteroNote(rawNote);

    let parentItemId: string | undefined;
    if (mapped.parentItemKey) {
      const parentBinding = await this.prisma.zoteroItemBinding.findUnique({
        where: {
          bindingId_remoteKey: {
            bindingId,
            remoteKey: mapped.parentItemKey,
          },
        },
      });
      parentItemId = parentBinding?.entityId;
    }

    const existingBinding = await this.prisma.zoteroItemBinding.findUnique({
      where: {
        bindingId_remoteKey: {
          bindingId,
          remoteKey: mapped.remoteKey,
        },
      },
    });

    let noteId: string;
    await this.txService.executeInTransaction(async (tx, helpers) => {
      if (existingBinding) {
        noteId = existingBinding.entityId;
        await tx.note.update({
          where: { id: noteId },
          data: {
            contentMd: mapped.contentHtml,
            version: { increment: 1 },
          },
        });

        await helpers.appendChange(workspaceId, {
          entityType: 'Note',
          entityId: noteId,
          action: 'update',
          version: 2,
        });
      } else {
        const created = await tx.note.create({
          data: {
            workspaceId,
            createdById: userId,
            itemId: parentItemId,
            contentMd: mapped.contentHtml,
            title: 'Zotero Note',
            version: 1,
          },
        });
        noteId = created.id;

        await helpers.appendChange(workspaceId, {
          entityType: 'Note',
          entityId: noteId,
          action: 'create',
          version: 1,
        });

        await helpers.publishOutbox(
          workspaceId,
          noteId,
          'library.zotero.note_synced',
          { noteId, remoteKey: mapped.remoteKey },
        );
      }

      await tx.zoteroItemBinding.upsert({
        where: {
          bindingId_remoteKey: {
            bindingId,
            remoteKey: mapped.remoteKey,
          },
        },
        create: {
          bindingId,
          workspaceId,
          entityType: 'note',
          entityId: noteId,
          remoteKey: mapped.remoteKey,
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
    });
  }

  private async processAnnotation(
    workspaceId: string,
    bindingId: string,
    userId: string,
    rawAnnotation: any,
  ): Promise<void> {
    const mapped = this.mapper.mapZoteroAnnotation(rawAnnotation);

    const parentAttBinding = await this.prisma.zoteroItemBinding.findUnique({
      where: {
        bindingId_remoteKey: {
          bindingId,
          remoteKey: mapped.parentAttachmentKey,
        },
      },
    });

    if (!parentAttBinding) {
      return;
    }

    const existingBinding = await this.prisma.zoteroItemBinding.findUnique({
      where: {
        bindingId_remoteKey: {
          bindingId,
          remoteKey: mapped.remoteKey,
        },
      },
    });

    let annotationId: string;
    await this.txService.executeInTransaction(async (tx, helpers) => {
      if (existingBinding) {
        annotationId = existingBinding.entityId;
        await tx.annotation.update({
          where: { id: annotationId },
          data: {
            quoteText: mapped.quote,
            comment: mapped.comment,
            color: mapped.color,
            version: { increment: 1 },
          },
        });

        await helpers.appendChange(workspaceId, {
          entityType: 'Annotation',
          entityId: annotationId,
          action: 'update',
          version: 2,
        });
      } else {
        const created = await tx.annotation.create({
          data: {
            attachmentId: parentAttBinding.entityId,
            authorId: userId,
            pageIndex: mapped.pageIndex,
            type: (mapped.annotationType as any) || 'highlight',
            quoteText: mapped.quote,
            comment: mapped.comment,
            color: mapped.color || '#ffd400',
            rectCoords: mapped.geometry || {},
            version: 1,
          },
        });
        annotationId = created.id;

        await helpers.appendChange(workspaceId, {
          entityType: 'Annotation',
          entityId: annotationId,
          action: 'create',
          version: 1,
        });

        await helpers.publishOutbox(
          workspaceId,
          annotationId,
          'library.zotero.annotation_synced',
          { annotationId, remoteKey: mapped.remoteKey },
        );
      }

      await tx.zoteroItemBinding.upsert({
        where: {
          bindingId_remoteKey: {
            bindingId,
            remoteKey: mapped.remoteKey,
          },
        },
        create: {
          bindingId,
          workspaceId,
          entityType: 'annotation',
          entityId: annotationId,
          remoteKey: mapped.remoteKey,
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
    });
  }
}
