import { Injectable, Logger } from '@nestjs/common';
import { ZoteroConnectionService } from './zotero-connection.service';
import { ZoteroConnector } from './zotero.connector';
import { ZoteroPullWorker, PullJobResult } from './zotero-pull.worker';
import { ZoteroPushWorker, PushItemResult } from './zotero-push.worker';
import {
  ZoteroReconcileWorker,
  ReconcileJobResult,
} from './zotero-reconcile.worker';
import { ZoteroSyncPolicy, KillSwitchStatus } from './zotero-sync.policy';
import { ZoteroFileConnector, StorageQuotaInfo } from './zotero-file.connector';
import { ZoteroConflictService } from './zotero-conflict.service';
import { ZoteroRepository } from './zotero.repository';
import {
  CreateZoteroConnectionDto,
  CreateZoteroBindingDto,
  ZoteroConnectionView,
} from './dto/zotero-connection.dto';
import { ResolveZoteroConflictDto } from './dto/resolve-zotero-conflict.dto';
import { SetKillSwitchDto } from './dto/set-kill-switch.dto';

/**
 * Public Domain Facade for the Zotero Integration Bounded Context.
 * The only entrypoint exported by ZoteroModule.
 */
@Injectable()
export class ZoteroService {
  private readonly logger = new Logger(ZoteroService.name);

  constructor(
    private readonly repository: ZoteroRepository,
    private readonly connectionService: ZoteroConnectionService,
    private readonly connector: ZoteroConnector,
    private readonly pullWorker: ZoteroPullWorker,
    private readonly pushWorker: ZoteroPushWorker,
    private readonly reconcileWorker: ZoteroReconcileWorker,
    private readonly syncPolicy: ZoteroSyncPolicy,
    private readonly fileConnector: ZoteroFileConnector,
    private readonly conflictService: ZoteroConflictService,
  ) {}

  // ── Connection Management ─────────────────────────────────────────────────

  async validateApiKey(
    apiKey: string,
  ): Promise<{ valid: boolean; userId?: string; username?: string }> {
    return this.connector.validateApiKey(apiKey);
  }

  async createConnection(
    workspaceId: string,
    userId: string,
    dto: CreateZoteroConnectionDto,
  ): Promise<ZoteroConnectionView> {
    const validation = await this.connector.validateApiKey(dto.apiKey);
    if (!validation.valid) {
      throw new Error('The provided Zotero API key is invalid or unauthorized');
    }

    return this.connectionService.createConnection(workspaceId, userId, {
      ...dto,
      zoteroUserId: validation.userId || dto.zoteroUserId,
      accountName: dto.accountName || validation.username || 'Zotero Account',
    });
  }

  async listConnections(workspaceId: string): Promise<ZoteroConnectionView[]> {
    return this.connectionService.listConnections(workspaceId);
  }

  async getConnection(
    workspaceId: string,
    connectionId: string,
  ): Promise<ZoteroConnectionView> {
    return this.connectionService.getConnection(connectionId, workspaceId);
  }

  async revokeConnection(
    workspaceId: string,
    connectionId: string,
  ): Promise<{ success: boolean }> {
    await this.connectionService.revokeConnection(connectionId, workspaceId);
    return { success: true };
  }

  async listRemoteLibraries(workspaceId: string, connectionId: string) {
    const connection = await this.connectionService.getConnection(
      connectionId,
      workspaceId,
    );
    const apiKey = await this.connectionService.getDecryptedApiKey(
      connectionId,
      workspaceId,
    );
    return this.connector.listLibraries(apiKey, connection.zoteroUserId || '0');
  }

  // ── Binding Management ────────────────────────────────────────────────────

  async createBinding(workspaceId: string, dto: CreateZoteroBindingDto) {
    return this.connectionService.createBinding(workspaceId, dto);
  }

  async listBindings(workspaceId: string, connectionId?: string) {
    return this.connectionService.listBindings(workspaceId, connectionId);
  }

  async updateBindingSyncDirection(
    workspaceId: string,
    bindingId: string,
    syncDirection: 'read_only' | 'two_way',
    userId?: string,
  ) {
    return this.connectionService.updateBindingSyncDirection(
      workspaceId,
      bindingId,
      syncDirection,
      userId,
    );
  }

  // ── Sync Execution & Workers ──────────────────────────────────────────────

  async executePull(
    workspaceId: string,
    bindingId: string,
  ): Promise<PullJobResult> {
    return this.pullWorker.executePull(workspaceId, bindingId);
  }

  async executePush(
    workspaceId: string,
    bindingId: string,
    itemId: string,
  ): Promise<PushItemResult> {
    return this.pushWorker.pushItem(workspaceId, bindingId, itemId);
  }

  async executeReconciliation(
    workspaceId: string,
    bindingId: string,
  ): Promise<ReconcileJobResult> {
    return this.reconcileWorker.executeReconciliation(workspaceId, bindingId);
  }

  // ── Conflict Resolution ───────────────────────────────────────────────────

  async listConflicts(workspaceId: string, bindingId?: string) {
    return this.connectionService.listConflicts(workspaceId, bindingId);
  }

  async listPendingPushes(workspaceId: string, bindingId: string) {
    return this.connectionService.listPendingPushes(workspaceId, bindingId);
  }

  async resolveConflict(
    workspaceId: string,
    bindingId: string,
    itemId: string,
    dto: ResolveZoteroConflictDto,
  ): Promise<PushItemResult> {
    return this.pushWorker.resolveConflict(workspaceId, bindingId, itemId, dto);
  }

  // ── Policy & Kill Switches ────────────────────────────────────────────────

  async getKillSwitchStatus(workspaceId: string): Promise<KillSwitchStatus> {
    return this.syncPolicy.getFreshKillSwitchStatus(workspaceId);
  }

  async setKillSwitch(
    workspaceId: string,
    dto: SetKillSwitchDto,
    userId: string,
  ): Promise<KillSwitchStatus> {
    if (dto.workspaceId && dto.workspaceId !== workspaceId) {
      await this.syncPolicy.setGlobalPushKillSwitch(
        dto.disabled,
        dto.reason,
        userId,
      );
    } else {
      await this.syncPolicy.setWorkspacePushKillSwitch(
        workspaceId,
        dto.disabled,
        dto.reason,
        userId,
      );
    }
    return this.syncPolicy.getFreshKillSwitchStatus(workspaceId);
  }

  // ── Storage Quota ─────────────────────────────────────────────────────────

  async getStorageQuota(
    workspaceId: string,
    bindingId: string,
  ): Promise<StorageQuotaInfo> {
    const binding = await this.connectionService
      .getConnection(bindingId, workspaceId)
      .catch(async () => {
        const bindings = await this.connectionService.listBindings(workspaceId);
        return bindings.find((b) => b.id === bindingId);
      });

    if (!binding) {
      return {
        total: 0,
        used: 0,
        available: 0,
        isExceeded: false,
        isUnavailable: true,
      };
    }

    const connectionId = (binding as any).connectionId || (binding as any).id;
    const apiKey = await this.connectionService.getDecryptedApiKey(
      connectionId,
      workspaceId,
    );
    const userId =
      (binding as any).zoteroUserId || (binding as any).remoteLibraryId || '0';

    return this.fileConnector.getStorageQuota(apiKey, userId);
  }
}
