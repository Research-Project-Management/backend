import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../../core/database/prisma.service';
import { ZoteroConnectionService } from './zotero-connection.service';
import { ZoteroConnector } from './zotero.connector';
import { ChangeLogRepository } from '../../sync-core/change-log.repository';
import { LibraryTransactionService } from '../../sync-core/library-transaction.service';

export interface ReconcileJobResult {
  deletedItems: number;
  deletedCollections: number;
  versionAfter: bigint;
}

@Injectable()
export class ZoteroReconcileWorker {
  private readonly logger = new Logger(ZoteroReconcileWorker.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly connectionService: ZoteroConnectionService,
    private readonly connector: ZoteroConnector,
    private readonly changeLogRepo: ChangeLogRepository,
    private readonly txService: LibraryTransactionService,
  ) {}

  /**
   * Reconciles remote deletions from Zotero and updates local tombstones atomically.
   */
  async executeReconciliation(
    workspaceId: string,
    bindingId: string,
  ): Promise<ReconcileJobResult> {
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

    const deletedRes = await this.connector.pullDeleted(
      apiKey,
      binding.remoteLibraryType as 'user' | 'group',
      binding.remoteLibraryId,
      binding.lastSyncVersion,
    );

    let deletedItems = 0;
    let deletedCollections = 0;

    // Process deleted items atomically
    for (const remoteKey of deletedRes.items) {
      const itemBinding = await this.prisma.zoteroItemBinding.findUnique({
        where: {
          bindingId_remoteKey: {
            bindingId,
            remoteKey,
          },
        },
      });

      if (itemBinding) {
        await this.txService.executeInTransaction(async (tx, helpers) => {
          if (itemBinding.entityType === 'item') {
            await tx.catalogItem.update({
              where: { id: itemBinding.entityId },
              data: { deletedAt: new Date() },
            });

            await helpers.appendChange(workspaceId, {
              entityType: 'CatalogItem',
              entityId: itemBinding.entityId,
              action: 'delete',
              version: 1,
            });

            await this.changeLogRepo.recordTombstone(
              workspaceId,
              {
                entityType: 'CatalogItem',
                entityId: itemBinding.entityId,
              },
              tx,
            );

            await helpers.publishOutbox(
              workspaceId,
              itemBinding.entityId,
              'library.zotero.item_deleted',
              { remoteKey },
            );

            deletedItems++;
          } else if (itemBinding.entityType === 'attachment') {
            await tx.catalogAttachment.delete({
              where: { id: itemBinding.entityId },
            });
            await helpers.appendChange(workspaceId, {
              entityType: 'CatalogAttachment',
              entityId: itemBinding.entityId,
              action: 'delete',
              version: 1,
            });
          } else if (itemBinding.entityType === 'note') {
            await tx.note.update({
              where: { id: itemBinding.entityId },
              data: { deletedAt: new Date() },
            });
            await helpers.appendChange(workspaceId, {
              entityType: 'Note',
              entityId: itemBinding.entityId,
              action: 'delete',
              version: 1,
            });
          } else if (itemBinding.entityType === 'annotation') {
            await tx.annotation.update({
              where: { id: itemBinding.entityId },
              data: { deletedAt: new Date() },
            });
            await helpers.appendChange(workspaceId, {
              entityType: 'Annotation',
              entityId: itemBinding.entityId,
              action: 'delete',
              version: 1,
            });
          }

          // Delete the item binding
          await tx.zoteroItemBinding.delete({
            where: { id: itemBinding.id },
          });
        });
      }
    }

    // Process deleted collections atomically
    for (const remoteKey of deletedRes.collections) {
      const colBinding = await this.prisma.zoteroItemBinding.findUnique({
        where: {
          bindingId_remoteKey: {
            bindingId,
            remoteKey,
          },
        },
      });

      if (colBinding && colBinding.entityType === 'collection') {
        await this.txService.executeInTransaction(async (tx, helpers) => {
          await tx.collection.update({
            where: { id: colBinding.entityId },
            data: { deletedAt: new Date() },
          });

          await helpers.appendChange(workspaceId, {
            entityType: 'Collection',
            entityId: colBinding.entityId,
            action: 'delete',
            version: 1,
          });

          await this.changeLogRepo.recordTombstone(
            workspaceId,
            {
              entityType: 'Collection',
              entityId: colBinding.entityId,
            },
            tx,
          );

          await tx.zoteroItemBinding.delete({
            where: { id: colBinding.id },
          });

          deletedCollections++;
        });
      }
    }

    // Update binding sync version if new version received
    if (deletedRes.version > binding.lastSyncVersion) {
      await this.prisma.zoteroBinding.update({
        where: { id: bindingId },
        data: {
          lastSyncVersion: deletedRes.version,
          lastSyncAt: new Date(),
        },
      });
    }

    return {
      deletedItems,
      deletedCollections,
      versionAfter:
        deletedRes.version > binding.lastSyncVersion
          ? deletedRes.version
          : binding.lastSyncVersion,
    };
  }
}
