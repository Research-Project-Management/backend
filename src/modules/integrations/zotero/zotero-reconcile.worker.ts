import { Injectable, Logger, Inject } from '@nestjs/common';
import { PrismaService } from '../../../core/database/prisma.service';
import { ZoteroConnectionService } from './zotero-connection.service';
import { ZoteroConnector } from './zotero.connector';
import {
  LIBRARY_SYNC_PORT,
  ILibrarySyncPort,
  SyncEntityType,
} from '../../library/library-sync.port';

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
    @Inject(LIBRARY_SYNC_PORT)
    private readonly libraryBridge: ILibrarySyncPort,
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
        let entityType: SyncEntityType = 'CatalogItem';
        if (itemBinding.entityType === 'attachment') {
          entityType = 'CatalogAttachment';
        } else if (itemBinding.entityType === 'note') {
          entityType = 'Note';
        } else if (itemBinding.entityType === 'annotation') {
          entityType = 'Annotation';
        } else if (itemBinding.entityType === 'collection') {
          entityType = 'Collection';
        }

        await this.libraryBridge.deleteEntity({
          workspaceId,
          entityType,
          entityId: itemBinding.entityId,
          publishOutboxEventType:
            itemBinding.entityType === 'item'
              ? 'library.zotero.item_deleted'
              : undefined,
          publishOutboxPayload:
            itemBinding.entityType === 'item' ? { remoteKey } : undefined,
        });

        if (itemBinding.entityType === 'item') {
          deletedItems++;
        }

        // Delete the item binding
        await this.prisma.zoteroItemBinding.delete({
          where: { id: itemBinding.id },
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
        await this.libraryBridge.deleteEntity({
          workspaceId,
          entityType: 'Collection',
          entityId: colBinding.entityId,
        });

        await this.prisma.zoteroItemBinding.delete({
          where: { id: colBinding.id },
        });

        deletedCollections++;
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
