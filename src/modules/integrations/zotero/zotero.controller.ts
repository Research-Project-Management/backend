import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  UseGuards,
  Query,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../iam/authn/guards/jwt-auth.guard';
import { WorkspaceRoleGuard } from '../../iam/authz/guards/workspace-role.guard';
import { WorkspaceRoles } from '../../iam/authz/decorators/workspace-roles.decorator';
import { WorkspaceRole } from '../../iam/authz/enums/workspace-role.enum';
import { CurrentUser } from '../../iam/authn/decorators/current-user.decorator';
import { ZoteroConnectionService } from './zotero-connection.service';
import { ZoteroConnector } from './zotero.connector';
import { ZoteroPullWorker } from './zotero-pull.worker';
import { ZoteroReconcileWorker } from './zotero-reconcile.worker';
import { ZoteroPushWorker } from './zotero-push.worker';
import { ZoteroSyncPolicy } from './zotero-sync.policy';
import { ZoteroFileConnector } from './zotero-file.connector';
import { SetKillSwitchDto } from './dto/set-kill-switch.dto';
import {
  CreateZoteroConnectionDto,
  CreateZoteroBindingDto,
} from './dto/zotero-connection.dto';
import { UpdateZoteroSyncDirectionDto } from './dto/update-zotero-sync-direction.dto';
import { ResolveZoteroConflictDto } from './dto/resolve-zotero-conflict.dto';

@Controller('api/v1/workspaces/:workspaceId/library/integrations/zotero')
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class ZoteroController {
  constructor(
    private readonly connectionService: ZoteroConnectionService,
    private readonly connector: ZoteroConnector,
    private readonly pullWorker: ZoteroPullWorker,
    private readonly reconcileWorker: ZoteroReconcileWorker,
    private readonly pushWorker: ZoteroPushWorker,
    private readonly syncPolicy: ZoteroSyncPolicy,
    private readonly fileConnector: ZoteroFileConnector,
  ) {}

  @Post('connections')
  @WorkspaceRoles(WorkspaceRole.ADMIN, WorkspaceRole.OWNER)
  async createConnection(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
    @Body() body: CreateZoteroConnectionDto,
  ) {
    // Validate API key with Zotero
    const validation = await this.connector.validateApiKey(body.apiKey);
    if (!validation.valid) {
      return {
        error: {
          code: 'ZOTERO_INVALID_API_KEY',
          message: 'The provided Zotero API key is invalid or unauthorized',
        },
      };
    }

    const connection = await this.connectionService.createConnection(
      workspaceId,
      userId,
      {
        ...body,
        zoteroUserId: validation.userId || body.zoteroUserId,
        accountName:
          body.accountName || validation.username || 'Zotero Account',
      },
    );

    return { data: connection };
  }

  @Get('connections')
  async listConnections(@Param('workspaceId') workspaceId: string) {
    const data = await this.connectionService.listConnections(workspaceId);
    return { data };
  }

  @Get('connections/:connectionId')
  async getConnection(
    @Param('workspaceId') workspaceId: string,
    @Param('connectionId') connectionId: string,
  ) {
    const data = await this.connectionService.getConnection(
      connectionId,
      workspaceId,
    );
    return { data };
  }

  @Delete('connections/:connectionId')
  @WorkspaceRoles(WorkspaceRole.ADMIN, WorkspaceRole.OWNER)
  async revokeConnection(
    @Param('workspaceId') workspaceId: string,
    @Param('connectionId') connectionId: string,
  ) {
    await this.connectionService.revokeConnection(connectionId, workspaceId);
    return { data: { success: true } };
  }

  @Get('connections/:connectionId/libraries')
  async listRemoteLibraries(
    @Param('workspaceId') workspaceId: string,
    @Param('connectionId') connectionId: string,
  ) {
    const connection = await this.connectionService.getConnection(
      connectionId,
      workspaceId,
    );
    const apiKey = await this.connectionService.getDecryptedApiKey(
      connectionId,
      workspaceId,
    );

    const libraries = await this.connector.listLibraries(
      apiKey,
      connection.zoteroUserId || '0',
    );

    return { data: libraries };
  }

  @Post('bindings')
  @WorkspaceRoles(WorkspaceRole.ADMIN, WorkspaceRole.OWNER)
  async createBinding(
    @Param('workspaceId') workspaceId: string,
    @Body() body: CreateZoteroBindingDto,
  ) {
    const binding = await this.connectionService.createBinding(
      workspaceId,
      body,
    );
    return {
      data: {
        ...binding,
        lastSyncVersion: binding.lastSyncVersion.toString(),
      },
    };
  }

  @Get('bindings')
  async listBindings(
    @Param('workspaceId') workspaceId: string,
    @Query('connectionId') connectionId?: string,
  ) {
    const bindings = await this.connectionService.listBindings(
      workspaceId,
      connectionId,
    );
    return {
      data: bindings.map((b) => ({
        ...b,
        lastSyncVersion: b.lastSyncVersion.toString(),
      })),
    };
  }

  @Patch('bindings/:bindingId/sync-direction')
  @WorkspaceRoles(WorkspaceRole.ADMIN, WorkspaceRole.OWNER)
  async updateSyncDirection(
    @Param('workspaceId') workspaceId: string,
    @Param('bindingId') bindingId: string,
    @CurrentUser('id') userId: string,
    @Body() body: UpdateZoteroSyncDirectionDto,
  ) {
    const updated = await this.connectionService.updateBindingSyncDirection(
      workspaceId,
      bindingId,
      body.syncDirection,
      userId,
    );
    return {
      data: {
        ...updated,
        lastSyncVersion: updated.lastSyncVersion.toString(),
      },
    };
  }

  @Post('bindings/:bindingId/sync-runs')
  @WorkspaceRoles(WorkspaceRole.ADMIN, WorkspaceRole.OWNER)
  async triggerPull(
    @Param('workspaceId') workspaceId: string,
    @Param('bindingId') bindingId: string,
  ) {
    const result = await this.pullWorker.executePull(workspaceId, bindingId);
    return {
      data: {
        ...result,
        versionAfter: result.versionAfter.toString(),
      },
    };
  }

  @Post('bindings/:bindingId/reconcile')
  @WorkspaceRoles(WorkspaceRole.ADMIN, WorkspaceRole.OWNER)
  async triggerReconcile(
    @Param('workspaceId') workspaceId: string,
    @Param('bindingId') bindingId: string,
  ) {
    const result = await this.reconcileWorker.executeReconciliation(
      workspaceId,
      bindingId,
    );
    return {
      data: {
        ...result,
        versionAfter: result.versionAfter.toString(),
      },
    };
  }

  @Post('bindings/:bindingId/push/:itemId')
  @WorkspaceRoles(WorkspaceRole.ADMIN, WorkspaceRole.OWNER)
  async pushItem(
    @Param('workspaceId') workspaceId: string,
    @Param('bindingId') bindingId: string,
    @Param('itemId') itemId: string,
  ) {
    const result = await this.pushWorker.pushItem(
      workspaceId,
      bindingId,
      itemId,
    );
    return {
      data: {
        ...result,
        remoteVersion: result.remoteVersion?.toString(),
      },
    };
  }

  @Get('conflicts')
  async listWorkspaceConflicts(@Param('workspaceId') workspaceId: string) {
    const data = await this.connectionService.listConflicts(workspaceId);
    return { data };
  }

  @Get('bindings/:bindingId/conflicts')
  async listBindingConflicts(
    @Param('workspaceId') workspaceId: string,
    @Param('bindingId') bindingId: string,
  ) {
    const data = await this.connectionService.listConflicts(
      workspaceId,
      bindingId,
    );
    return { data };
  }

  @Get('bindings/:bindingId/pending-pushes')
  async listPendingPushes(
    @Param('workspaceId') workspaceId: string,
    @Param('bindingId') bindingId: string,
  ) {
    const data = await this.connectionService.listPendingPushes(
      workspaceId,
      bindingId,
    );
    return { data };
  }

  @Post('bindings/:bindingId/conflicts/:itemId/resolve')
  @WorkspaceRoles(WorkspaceRole.ADMIN, WorkspaceRole.OWNER)
  async resolveConflict(
    @Param('workspaceId') workspaceId: string,
    @Param('bindingId') bindingId: string,
    @Param('itemId') itemId: string,
    @Body() body: ResolveZoteroConflictDto,
  ) {
    const result = await this.pushWorker.resolveConflict(
      workspaceId,
      bindingId,
      itemId,
      body,
    );
    return {
      data: {
        ...result,
        remoteVersion: result.remoteVersion?.toString(),
      },
    };
  }

  @Get('kill-switch')
  async getKillSwitchStatus(@Param('workspaceId') workspaceId: string) {
    const status = await this.syncPolicy.getFreshKillSwitchStatus(workspaceId);
    return { data: status };
  }

  @Post('kill-switch')
  @WorkspaceRoles(WorkspaceRole.ADMIN, WorkspaceRole.OWNER)
  async setKillSwitch(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
    @Body() body: SetKillSwitchDto,
  ) {
    if (body.workspaceId && body.workspaceId !== workspaceId) {
      // Global operator switch
      await this.syncPolicy.setGlobalPushKillSwitch(
        body.disabled,
        body.reason,
        userId,
      );
    } else {
      await this.syncPolicy.setWorkspacePushKillSwitch(
        workspaceId,
        body.disabled,
        body.reason,
        userId,
      );
    }
    const status = await this.syncPolicy.getFreshKillSwitchStatus(workspaceId);
    return { data: status };
  }

  @Get('bindings/:bindingId/storage/quota')
  async getStorageQuota(
    @Param('workspaceId') workspaceId: string,
    @Param('bindingId') bindingId: string,
  ) {
    const binding = await this.connectionService
      .getConnection(bindingId, workspaceId)
      .catch(async () => {
        const bindings = await this.connectionService.listBindings(workspaceId);
        return bindings.find((b) => b.id === bindingId);
      });

    if (!binding) {
      return {
        data: {
          total: 0,
          used: 0,
          available: 0,
          isExceeded: false,
          isUnavailable: true,
        },
      };
    }

    const connectionId = (binding as any).connectionId || (binding as any).id;
    const apiKey = await this.connectionService.getDecryptedApiKey(
      connectionId,
      workspaceId,
    );
    const userId =
      (binding as any).zoteroUserId || (binding as any).remoteLibraryId || '0';

    const quota = await this.fileConnector.getStorageQuota(apiKey, userId);
    return { data: quota };
  }
}
