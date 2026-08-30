import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  Inject,
} from '@nestjs/common';
import { PrismaService } from '../../../core/database/prisma.service';
import { ZoteroConnectionService } from './zotero-connection.service';
import { ZoteroConnector } from './zotero.connector';
import { ZoteroMapper } from './zotero.mapper';
import { ZoteroConflictService } from './zotero-conflict.service';
import { ZoteroSyncPolicy } from './zotero-sync.policy';
import { ResolveZoteroConflictDto } from './dto/resolve-zotero-conflict.dto';
import { SYNC_PORT, SyncPort } from '../../library/sync/ports/sync.port';

export interface PushItemResult {
  success: boolean;
  status: 'synced' | 'conflict' | 'skipped';
  remoteKey?: string;
  remoteVersion?: bigint;
  conflictDetails?: any;
  reason?: string;
}

@Injectable()
export class ZoteroPushWorker {
  private readonly logger = new Logger(ZoteroPushWorker.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly connectionService: ZoteroConnectionService,
    private readonly connector: ZoteroConnector,
    private readonly mapper: ZoteroMapper,
    private readonly conflictService: ZoteroConflictService,
    private readonly syncPolicy: ZoteroSyncPolicy,
    @Inject(SYNC_PORT)
    private readonly libraryBridge: SyncPort,
  ) {}

  /**
   * Pushes a local CatalogItem change to Zotero with 3-way merge conflict detection and version preconditions.
   */
  async pushItem(
    workspaceId: string,
    bindingId: string,
    itemId: string,
  ): Promise<PushItemResult> {
    // 1. Verify policy eligibility upfront
    if (!this.syncPolicy.isPushEnabled(workspaceId)) {
      return {
        success: false,
        status: 'skipped',
        reason: 'kill_switch_active',
      };
    }

    const binding = await this.prisma.zoteroBinding.findUnique({
      where: { id: bindingId },
      include: { connection: true },
    });

    if (!binding || binding.workspaceId !== workspaceId) {
      throw new NotFoundException(
        `Zotero binding ${bindingId} not found in workspace ${workspaceId}`,
      );
    }

    const eligibility = this.syncPolicy.validatePushEligibility(
      workspaceId,
      binding,
    );
    if (!eligibility.eligible) {
      this.logger.log(
        `Push skipped for item ${itemId} on binding ${bindingId}: ${eligibility.reason}`,
      );
      return {
        success: false,
        status: 'skipped',
        reason: eligibility.reason,
      };
    }

    const item = await this.libraryBridge.getItemSnapshot({
      workspaceId,
      itemId,
    });

    if (!item || item.workspaceId !== workspaceId) {
      throw new NotFoundException(
        `Catalog item ${itemId} not found in workspace ${workspaceId}`,
      );
    }

    const itemBinding = await this.prisma.zoteroItemBinding.findFirst({
      where: {
        bindingId,
        entityType: 'item',
        entityId: itemId,
      },
    });

    const apiKey = await this.connectionService.getDecryptedApiKey(
      binding.connectionId,
      workspaceId,
    );

    const tags = item.tags;
    const localPayload = this.mapper.mapToZoteroItem(
      {
        title: item.title,
        abstract: item.abstract,
        year: item.year,
        doi: item.doi,
        publicationTitle: item.publicationTitle,
        volume: item.volume,
        issue: item.issue,
        pages: item.pages,
        issn: item.issn,
        isbn: item.isbn,
        url: item.url,
        tags,
      },
      (itemBinding?.rawPayload as Record<string, any>) || undefined,
    );

    // Case A: First-time push (create remote item)
    if (!itemBinding) {
      const res = await this.connector.pushItem(
        apiKey,
        binding.remoteLibraryType as 'user' | 'group',
        binding.remoteLibraryId,
        localPayload,
      );

      // Create new binding in synced state
      await this.prisma.zoteroItemBinding.create({
        data: {
          bindingId,
          workspaceId,
          entityType: 'item',
          entityId: itemId,
          remoteKey: res.key,
          remoteVersion: res.version,
          rawPayload: localPayload,
          baseSnapshot: localPayload,
          syncState: 'synced',
        },
      });

      await this.libraryBridge.publishIntegrationEvent({
        workspaceId,
        aggregateId: itemId,
        eventType: 'library.zotero.item_pushed',
        payload: {
          itemId,
          remoteKey: res.key,
          remoteVersion: Number(res.version),
          operation: 'create',
        },
      });

      return {
        success: true,
        status: 'synced',
        remoteKey: res.key,
        remoteVersion: res.version,
      };
    }

    // Case B: Existing remote binding -> perform update with precondition check
    const isPolicyActive =
      await this.syncPolicy.checkEffectivePolicyDirect(workspaceId);
    if (!isPolicyActive.globalDisabled && isPolicyActive.workspaceDisabled) {
      return {
        success: false,
        status: 'skipped',
        reason: 'workspace_push_disabled',
      };
    }

    const pushRes = await this.connector.pushItem(
      apiKey,
      binding.remoteLibraryType as 'user' | 'group',
      binding.remoteLibraryId,
      localPayload,
      itemBinding.remoteKey,
      itemBinding.remoteVersion,
    );

    if (pushRes.success) {
      await this.prisma.zoteroItemBinding.update({
        where: { id: itemBinding.id },
        data: {
          syncState: 'synced',
          remoteVersion: pushRes.version,
          rawPayload: localPayload,
          baseSnapshot: localPayload,
        },
      });

      await this.libraryBridge.publishIntegrationEvent({
        workspaceId,
        aggregateId: itemId,
        eventType: 'library.zotero.item_pushed',
        payload: {
          itemId,
          remoteKey: itemBinding.remoteKey,
          remoteVersion: Number(pushRes.version),
          operation: 'update',
        },
      });

      return {
        success: true,
        status: 'synced',
        remoteKey: itemBinding.remoteKey,
        remoteVersion: pushRes.version,
      };
    }

    // Case C: Precondition failed (HTTP 412) -> Mid-air collision detected
    if (pushRes.conflict) {
      return this.handlePushConflict(
        workspaceId,
        bindingId,
        binding,
        apiKey,
        item,
        itemBinding,
        localPayload,
      );
    }

    throw new Error('Unexpected Zotero push response status');
  }

  /**
   * Pushes a local entity deletion to Zotero with version preconditions.
   */
  async pushDeletedItem(
    workspaceId: string,
    bindingId: string,
    itemId: string,
    remoteKey: string,
    remoteVersion?: bigint,
  ): Promise<{ success: boolean; status: 'deleted' | 'conflict' | 'skipped' }> {
    if (!this.syncPolicy.isPushEnabled(workspaceId)) {
      return { success: false, status: 'skipped' };
    }

    const binding = await this.prisma.zoteroBinding.findUnique({
      where: { id: bindingId },
      include: { connection: true },
    });

    if (!binding || binding.workspaceId !== workspaceId) {
      throw new NotFoundException(`Zotero binding ${bindingId} not found`);
    }

    const eligibility = this.syncPolicy.validatePushEligibility(
      workspaceId,
      binding,
    );
    if (!eligibility.eligible) {
      return { success: false, status: 'skipped' };
    }

    const apiKey = await this.connectionService.getDecryptedApiKey(
      binding.connectionId,
      workspaceId,
    );

    const isPolicyActive =
      await this.syncPolicy.checkEffectivePolicyDirect(workspaceId);
    if (!isPolicyActive) {
      return { success: false, status: 'skipped' };
    }

    const deleteRes = await this.connector.deleteItemRemote(
      apiKey,
      binding.remoteLibraryType as 'user' | 'group',
      binding.remoteLibraryId,
      remoteKey,
      remoteVersion,
    );

    if (deleteRes.conflict) {
      // Remote was modified after local deletion -> flag conflict
      await this.prisma.zoteroItemBinding.updateMany({
        where: { bindingId, remoteKey },
        data: { syncState: 'conflict' },
      });
      return { success: false, status: 'conflict' };
    }

    // Delete local entity if present
    await this.libraryBridge.deleteEntity({
      workspaceId,
      entityType: 'CatalogItem',
      entityId: itemId,
    });

    // Directly publish integration outbox event
    await this.libraryBridge.publishIntegrationEvent({
      workspaceId,
      aggregateId: itemId,
      eventType: 'library.zotero.item_deleted_pushed',
      payload: { itemId, remoteKey },
    });

    await this.prisma.zoteroItemBinding.deleteMany({
      where: { bindingId, remoteKey },
    });

    return { success: true, status: 'deleted' };
  }

  /**
   * Resolves mid-air collision via 3-way merge.
   */
  private async handlePushConflict(
    workspaceId: string,
    bindingId: string,
    binding: any,
    apiKey: string,
    item: any,
    itemBinding: any,
    localPayload: any,
  ): Promise<PushItemResult> {
    this.logger.warn(
      `Push conflict detected for item ${item.id} (remote key: ${itemBinding.remoteKey}). Fetching remote delta for 3-way merge.`,
    );

    // 1. Fetch current remote item state
    const pullRes = await this.connector.pullItems(
      apiKey,
      binding.remoteLibraryType as 'user' | 'group',
      binding.remoteLibraryId,
      {
        sinceVersion: itemBinding.remoteVersion,
        limit: 5,
      },
    );

    const remoteRaw = pullRes.items.find(
      (i) => String(i.key || i.data?.key) === itemBinding.remoteKey,
    );

    if (!remoteRaw) {
      // Remote item was deleted concurrently!
      await this.prisma.zoteroItemBinding.update({
        where: { id: itemBinding.id },
        data: { syncState: 'conflict' },
      });

      return {
        success: false,
        status: 'conflict',
        remoteKey: itemBinding.remoteKey,
        conflictDetails: {
          type: 'remote_deleted',
          message: 'The item was deleted on Zotero while modified locally.',
        },
      };
    }

    const remotePayload = remoteRaw.data || remoteRaw;
    const remoteVersion = BigInt(remoteRaw.version || pullRes.version);
    const basePayload =
      itemBinding.baseSnapshot || itemBinding.rawPayload || {};

    // 2. Perform 3-way merge
    const mergeResult = this.conflictService.mergeItemThreeWay(
      basePayload,
      localPayload,
      remotePayload,
    );

    // Case A: Clean Auto-Merge
    if (!mergeResult.hasConflict) {
      this.logger.log(
        `Clean 3-way auto-merge successful for item ${item.id}. Retrying push with merged payload.`,
      );

      const retryPush = await this.connector.pushItem(
        apiKey,
        binding.remoteLibraryType as 'user' | 'group',
        binding.remoteLibraryId,
        mergeResult.mergedData,
        itemBinding.remoteKey,
        remoteVersion,
      );

      if (retryPush.success) {
        // Update local entity with merged fields
        await this.libraryBridge.upsertCatalogItem({
          workspaceId,
          userId: binding.connection.userId,
          existingId: item.id,
          title: mergeResult.mergedData.title || item.title,
          abstract: mergeResult.mergedData.abstractNote || item.abstract,
        });

        await this.prisma.zoteroItemBinding.update({
          where: { id: itemBinding.id },
          data: {
            syncState: 'synced',
            remoteVersion: retryPush.version,
            rawPayload: mergeResult.mergedData,
            baseSnapshot: mergeResult.mergedData,
          },
        });

        return {
          success: true,
          status: 'synced',
          remoteKey: itemBinding.remoteKey,
          remoteVersion: retryPush.version,
        };
      }
    }

    // Case B: Overlapping Conflict -> Flag for Manual Resolution
    this.logger.warn(
      `Irreconcilable conflict on item ${item.id}. Conflicting fields: ${mergeResult.conflicts.map((c: any) => c.field).join(', ')}`,
    );

    const conflictRecord = {
      bindingId,
      entityId: item.id,
      remoteKey: itemBinding.remoteKey,
      baseVersion: itemBinding.remoteVersion.toString(),
      remoteVersion: remoteVersion.toString(),
      conflicts: mergeResult.conflicts as any,
      baseSnapshot: basePayload,
      localSnapshot: localPayload,
      remoteSnapshot: remotePayload,
    };

    await this.prisma.$transaction([
      this.prisma.zoteroItemBinding.update({
        where: { id: itemBinding.id },
        data: {
          syncState: 'conflict',
          remoteVersion,
        },
      }),
      this.prisma.zoteroSyncFailure.create({
        data: {
          bindingId,
          workspaceId,
          operation: 'push_item',
          entityId: item.id,
          status: 'conflict',
          errorMessage: `Conflicting changes on fields: ${mergeResult.conflicts.map((c: any) => c.field).join(', ')}`,
          errorDetails: conflictRecord as any,
        },
      }),
    ]);

    await this.libraryBridge.publishIntegrationEvent({
      workspaceId,
      aggregateId: item.id,
      eventType: 'library.zotero.conflict_detected',
      payload: conflictRecord,
    });

    return {
      success: false,
      status: 'conflict',
      remoteKey: itemBinding.remoteKey,
      remoteVersion,
      conflictDetails: mergeResult.conflicts,
    };
  }

  /**
   * Resolves a flagged sync conflict explicitly by user choice.
   */
  async resolveConflict(
    workspaceId: string,
    bindingId: string,
    itemId: string,
    dto: ResolveZoteroConflictDto,
  ): Promise<PushItemResult> {
    const itemBinding = await this.prisma.zoteroItemBinding.findFirst({
      where: {
        bindingId,
        entityType: 'item',
        entityId: itemId,
      },
      include: {
        binding: {
          include: { connection: true },
        },
      },
    });

    if (!itemBinding) {
      throw new NotFoundException(`No binding found for item ${itemId}`);
    }

    if (itemBinding.syncState !== 'conflict') {
      throw new BadRequestException(`Item ${itemId} is not in conflict state`);
    }

    const apiKey = await this.connectionService.getDecryptedApiKey(
      itemBinding.binding.connectionId,
      workspaceId,
    );

    const resolvedFields: Record<string, any> = { ...dto };
    const pushPayload = this.mapper.mapToZoteroItem(
      resolvedFields,
      (itemBinding.rawPayload as Record<string, any>) || undefined,
    );

    // Push resolved version with remoteVersion precondition
    const pushRes = await this.connector.pushItem(
      apiKey,
      itemBinding.binding.remoteLibraryType as 'user' | 'group',
      itemBinding.binding.remoteLibraryId,
      pushPayload,
      itemBinding.remoteKey,
      itemBinding.remoteVersion,
    );

    if (pushRes.conflict) {
      const pullRes = await this.connector.pullItems(
        apiKey,
        itemBinding.binding.remoteLibraryType as 'user' | 'group',
        itemBinding.binding.remoteLibraryId,
        {
          sinceVersion: itemBinding.remoteVersion,
          limit: 5,
        },
      );
      const latestRaw = pullRes.items.find(
        (i) => String(i.key || i.data?.key) === itemBinding.remoteKey,
      );
      const latestVersion = BigInt(latestRaw?.version || pullRes.version);

      await this.prisma.zoteroItemBinding.update({
        where: { id: itemBinding.id },
        data: {
          remoteVersion: latestVersion,
        },
      });

      return {
        success: false,
        status: 'conflict',
        remoteKey: itemBinding.remoteKey,
        conflictDetails: 'Remote was modified again during conflict resolution',
      };
    }

    if (!pushRes.success) {
      throw new Error('Failed to push resolved item to Zotero');
    }

    // Update local entity and clear conflict state
    await this.libraryBridge.upsertCatalogItem({
      workspaceId,
      userId: itemBinding.binding.connection.userId,
      existingId: itemId,
      title: resolvedFields.title,
      abstract: resolvedFields.abstract || resolvedFields.abstractNote,
    });

    await this.prisma.zoteroItemBinding.update({
      where: { id: itemBinding.id },
      data: {
        syncState: 'synced',
        remoteVersion: pushRes.version,
        rawPayload: pushPayload,
        baseSnapshot: pushPayload,
      },
    });

    await this.prisma.zoteroSyncFailure.updateMany({
      where: {
        bindingId,
        entityId: itemId,
      },
      data: {
        status: 'resolved',
      },
    });

    await this.libraryBridge.publishIntegrationEvent({
      workspaceId,
      aggregateId: itemId,
      eventType: 'library.zotero.conflict_resolved',
      payload: {
        bindingId,
        itemId,
        remoteVersion: Number(pushRes.version),
      },
    });

    return {
      success: true,
      status: 'synced',
      remoteKey: itemBinding.remoteKey,
      remoteVersion: pushRes.version,
    };
  }
}
