import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../../../../core/database/prisma.service';
import { ZoteroConnectionService } from './zotero-connection.service';
import { ZoteroConnector } from './zotero.connector';
import { ZoteroMapper } from './zotero.mapper';
import { ZoteroConflictService } from './zotero-conflict.service';
import { ZoteroSyncPolicy } from './zotero-sync-policy';
import { LibraryTransactionService } from '../../sync-core/library-transaction.service';
import { ResolveZoteroConflictDto } from './dto/resolve-zotero-conflict.dto';

export interface PushItemResult {
  success: boolean;
  status: 'synced' | 'conflict' | 'skipped' | 'failed';
  reason?: string;
  remoteKey?: string;
  remoteVersion?: bigint;
  conflictDetails?: any;
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
    private readonly txService: LibraryTransactionService,
  ) {}

  /**
   * Pushes a local CatalogItem to Zotero with strict capability checks, version preconditions, and 3-way conflict handling.
   */
  async pushCatalogItem(
    workspaceId: string,
    bindingId: string,
    itemId: string,
  ): Promise<PushItemResult> {
    // 1. Early kill-switch / policy check
    if (!this.syncPolicy.isPushEnabled(workspaceId)) {
      return {
        success: false,
        status: 'skipped',
        reason: 'push_disabled_by_policy',
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

    // 1. Validate push eligibility (Sync Direction, Inactive Connection, Kill-Switch, Feature Flag)
    const eligibility = this.syncPolicy.validatePushEligibility(
      workspaceId,
      binding,
    );
    if (!eligibility.eligible) {
      this.logger.debug(
        `Push skipped for item ${itemId} on binding ${bindingId}: ${eligibility.reason}`,
      );
      return {
        success: false,
        status: 'skipped',
        reason: eligibility.reason,
      };
    }

    const item = await this.prisma.catalogItem.findUnique({
      where: { id: itemId },
      include: {
        itemTags: { include: { tag: true } },
      },
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

    const tags = item.itemTags.map((it) => it.tag.name);
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
      (itemBinding?.rawPayload as Record<string, any>) || {},
    );

    // 2. Perform optimistic write to Zotero with immediate pre-write policy verification
    const isPolicyActive =
      await this.syncPolicy.checkEffectivePolicyDirect(workspaceId);
    if (!isPolicyActive) {
      return {
        success: false,
        status: 'skipped',
        reason: 'kill_switch_active',
      };
    }

    const pushRes = await this.connector.pushItem(
      apiKey,
      binding.remoteLibraryType as 'user' | 'group',
      binding.remoteLibraryId,
      localPayload,
      itemBinding?.remoteKey,
      itemBinding?.remoteVersion,
    );

    if (pushRes.conflict) {
      this.logger.warn(
        `Mid-air collision detected pushing item ${itemId} (remote version mismatch)`,
      );

      // Handle 3-way merge
      return this.handlePushConflict(
        workspaceId,
        bindingId,
        binding,
        apiKey,
        item,
        itemBinding!,
        localPayload,
      );
    }

    if (!pushRes.success) {
      throw new Error(`Push item ${itemId} failed to Zotero`);
    }

    // 3. Atomically update binding and emit outbox event
    await this.txService.executeInTransaction(async (tx, helpers) => {
      await tx.zoteroItemBinding.upsert({
        where: {
          bindingId_remoteKey: {
            bindingId,
            remoteKey: pushRes.key,
          },
        },
        create: {
          bindingId,
          workspaceId,
          entityType: 'item',
          entityId: itemId,
          remoteKey: pushRes.key,
          remoteVersion: pushRes.version,
          rawPayload: localPayload,
          baseSnapshot: localPayload,
          syncState: 'synced',
        },
        update: {
          remoteVersion: pushRes.version,
          rawPayload: localPayload,
          baseSnapshot: localPayload,
          syncState: 'synced',
        },
      });

      await helpers.publishOutbox(
        workspaceId,
        itemId,
        'library.zotero.item_pushed',
        {
          itemId,
          remoteKey: pushRes.key,
          version: pushRes.version.toString(),
        },
      );
    });

    return {
      success: true,
      status: 'synced',
      remoteKey: pushRes.key,
      remoteVersion: pushRes.version,
    };
  }

  /**
   * Propagates local deletion to Zotero with version precondition.
   */
  async pushDeletedItem(
    workspaceId: string,
    bindingId: string,
    itemId: string,
    remoteKey: string,
    remoteVersion?: bigint,
  ): Promise<{ success: boolean; status: 'deleted' | 'conflict' | 'skipped' }> {
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

    // Atomically delete binding
    await this.txService.executeInTransaction(async (tx, helpers) => {
      await tx.zoteroItemBinding.deleteMany({
        where: { bindingId, remoteKey },
      });

      await helpers.publishOutbox(
        workspaceId,
        itemId,
        'library.zotero.item_deleted_pushed',
        { itemId, remoteKey },
      );
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
    localPayload: Record<string, any>,
  ): Promise<PushItemResult> {
    // Pull current remote version from Zotero
    const pullRes = await this.connector.pullItems(
      apiKey,
      binding.remoteLibraryType,
      binding.remoteLibraryId,
      {
        sinceVersion:
          itemBinding.remoteVersion > BigInt(0)
            ? itemBinding.remoteVersion - BigInt(1)
            : BigInt(0),
        limit: 10,
      },
    );

    const rawRemote = pullRes.items.find(
      (ri: any) => String(ri.key || ri.data?.key) === itemBinding.remoteKey,
    );

    const remoteData = rawRemote?.data || rawRemote || {};
    const baseData = (itemBinding.baseSnapshot as Record<string, any>) || {};

    const mergeResult = this.conflictService.mergeItemThreeWay(
      baseData,
      localPayload,
      remoteData,
    );

    if (!mergeResult.hasConflict) {
      this.logger.log(
        `Auto-merging non-conflicting changes for item ${item.id}`,
      );

      const latestRemoteVersion = BigInt(remoteData.version || pullRes.version);
      const retryPush = await this.connector.pushItem(
        apiKey,
        binding.remoteLibraryType,
        binding.remoteLibraryId,
        mergeResult.mergedData,
        itemBinding.remoteKey,
        latestRemoteVersion,
      );

      if (retryPush.success) {
        await this.txService.executeInTransaction(async (tx, helpers) => {
          const updatedItem = await tx.catalogItem.update({
            where: { id: item.id },
            data: {
              title: mergeResult.mergedData.title || item.title,
              abstract: mergeResult.mergedData.abstractNote || item.abstract,
              version: { increment: 1 },
            },
          });

          await tx.zoteroItemBinding.update({
            where: { id: itemBinding.id },
            data: {
              remoteVersion: retryPush.version,
              rawPayload: mergeResult.mergedData,
              baseSnapshot: mergeResult.mergedData,
              syncState: 'synced',
            },
          });

          await helpers.appendChange(workspaceId, {
            entityType: 'CatalogItem',
            entityId: item.id,
            action: 'update',
            version: updatedItem.version,
            data: mergeResult.mergedData,
          });
        });

        return {
          success: true,
          status: 'synced',
          remoteKey: itemBinding.remoteKey,
          remoteVersion: retryPush.version,
        };
      }
    }

    // Conflicting fields require user resolution
    this.logger.warn(
      `Conflict detected on item ${item.id}: ${mergeResult.conflicts.map((c) => c.field).join(', ')}`,
    );

    // Atomically transition item binding to conflict state and record failure
    await this.prisma.$transaction([
      this.prisma.zoteroItemBinding.update({
        where: { id: itemBinding.id },
        data: {
          syncState: 'conflict',
          baseSnapshot: {
            baseData,
            localData: localPayload,
            remoteData,
            conflicts: mergeResult.conflicts,
          } as any,
        },
      }),
      this.prisma.zoteroSyncFailure.create({
        data: {
          bindingId,
          workspaceId,
          operation: 'push_item',
          remoteKey: itemBinding.remoteKey,
          entityId: item.id,
          errorMessage: `Three-way merge conflict on fields: ${mergeResult.conflicts.map((c) => c.field).join(', ')}`,
          errorDetails: {
            conflicts: mergeResult.conflicts,
            remoteData,
            localData: localPayload,
          } as any,
          status: 'conflict',
        },
      }),
    ]);

    return {
      success: false,
      status: 'conflict',
      remoteKey: itemBinding.remoteKey,
      conflictDetails: mergeResult.conflicts,
    };
  }

  /**
   * Resolves a recorded conflict by applying user-chosen field values.
   */
  async resolveConflict(
    workspaceId: string,
    bindingId: string,
    itemId: string,
    resolvedFields: ResolveZoteroConflictDto,
  ): Promise<PushItemResult> {
    const itemBinding = await this.prisma.zoteroItemBinding.findFirst({
      where: {
        bindingId,
        entityType: 'item',
        entityId: itemId,
      },
      include: {
        binding: { include: { connection: true } },
      },
    });

    if (!itemBinding || itemBinding.workspaceId !== workspaceId) {
      throw new NotFoundException(
        `Zotero item binding for item ${itemId} not found in workspace ${workspaceId}`,
      );
    }

    if (itemBinding.syncState !== 'conflict') {
      throw new BadRequestException(
        `Item ${itemId} is not in conflict state (current state: ${itemBinding.syncState})`,
      );
    }

    const apiKey = await this.connectionService.getDecryptedApiKey(
      itemBinding.binding.connectionId,
      workspaceId,
    );

    // Format payload for Zotero API
    const pushPayload = this.mapper.mapToZoteroItem(
      resolvedFields,
      (itemBinding.rawPayload as Record<string, any>) || {},
    );

    // Push resolved payload to remote
    const pushRes = await this.connector.pushItem(
      apiKey,
      itemBinding.binding.remoteLibraryType as 'user' | 'group',
      itemBinding.binding.remoteLibraryId,
      pushPayload,
      itemBinding.remoteKey,
      itemBinding.remoteVersion,
    );

    if (pushRes.conflict) {
      // Remote was modified again during resolution!
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

    // Atomically update local entity and clear conflict state
    await this.txService.executeInTransaction(async (tx, helpers) => {
      const updatedItem = await tx.catalogItem.update({
        where: { id: itemId },
        data: {
          title: resolvedFields.title,
          abstract: resolvedFields.abstract || resolvedFields.abstractNote,
          version: { increment: 1 },
        },
      });

      await tx.zoteroItemBinding.update({
        where: { id: itemBinding.id },
        data: {
          syncState: 'synced',
          remoteVersion: pushRes.version,
          rawPayload: pushPayload,
          baseSnapshot: pushPayload,
        },
      });

      await tx.zoteroSyncFailure.updateMany({
        where: {
          bindingId,
          entityId: itemId,
          status: 'conflict',
        },
        data: {
          status: 'resolved',
        },
      });

      await helpers.appendChange(workspaceId, {
        entityType: 'CatalogItem',
        entityId: itemId,
        action: 'update',
        version: updatedItem.version,
        data: pushPayload,
      });

      await helpers.publishOutbox(
        workspaceId,
        itemId,
        'library.zotero.conflict_resolved',
        { itemId, remoteKey: itemBinding.remoteKey },
      );
    });

    return {
      success: true,
      status: 'synced',
      remoteKey: itemBinding.remoteKey,
      remoteVersion: pushRes.version,
    };
  }
}
