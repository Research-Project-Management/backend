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
import { ZoteroService } from './zotero.service';
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
  constructor(private readonly zoteroService: ZoteroService) {}

  @Post('connections')
  @WorkspaceRoles(WorkspaceRole.ADMIN, WorkspaceRole.OWNER)
  async createConnection(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
    @Body() body: CreateZoteroConnectionDto,
  ) {
    const connection = await this.zoteroService.createConnection(
      workspaceId,
      userId,
      body,
    );
    return { data: connection };
  }

  @Get('connections')
  async listConnections(@Param('workspaceId') workspaceId: string) {
    const data = await this.zoteroService.listConnections(workspaceId);
    return { data };
  }

  @Get('connections/:connectionId')
  async getConnection(
    @Param('workspaceId') workspaceId: string,
    @Param('connectionId') connectionId: string,
  ) {
    const data = await this.zoteroService.getConnection(
      workspaceId,
      connectionId,
    );
    return { data };
  }

  @Delete('connections/:connectionId')
  @WorkspaceRoles(WorkspaceRole.ADMIN, WorkspaceRole.OWNER)
  async revokeConnection(
    @Param('workspaceId') workspaceId: string,
    @Param('connectionId') connectionId: string,
  ) {
    const res = await this.zoteroService.revokeConnection(
      workspaceId,
      connectionId,
    );
    return { data: res };
  }

  @Get('connections/:connectionId/libraries')
  async listRemoteLibraries(
    @Param('workspaceId') workspaceId: string,
    @Param('connectionId') connectionId: string,
  ) {
    const libraries = await this.zoteroService.listRemoteLibraries(
      workspaceId,
      connectionId,
    );
    return { data: libraries };
  }

  @Post('bindings')
  @WorkspaceRoles(WorkspaceRole.ADMIN, WorkspaceRole.OWNER)
  async createBinding(
    @Param('workspaceId') workspaceId: string,
    @Body() body: CreateZoteroBindingDto,
  ) {
    const binding = await this.zoteroService.createBinding(workspaceId, body);
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
    const bindings = await this.zoteroService.listBindings(
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
    const updated = await this.zoteroService.updateBindingSyncDirection(
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
    const result = await this.zoteroService.executePull(workspaceId, bindingId);
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
    const result = await this.zoteroService.executeReconciliation(
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
    const result = await this.zoteroService.executePush(
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
    const data = await this.zoteroService.listConflicts(workspaceId);
    return { data };
  }

  @Get('bindings/:bindingId/conflicts')
  async listBindingConflicts(
    @Param('workspaceId') workspaceId: string,
    @Param('bindingId') bindingId: string,
  ) {
    const data = await this.zoteroService.listConflicts(workspaceId, bindingId);
    return { data };
  }

  @Get('bindings/:bindingId/pending-pushes')
  async listPendingPushes(
    @Param('workspaceId') workspaceId: string,
    @Param('bindingId') bindingId: string,
  ) {
    const data = await this.zoteroService.listPendingPushes(
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
    const result = await this.zoteroService.resolveConflict(
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
    const status = await this.zoteroService.getKillSwitchStatus(workspaceId);
    return { data: status };
  }

  @Post('kill-switch')
  @WorkspaceRoles(WorkspaceRole.ADMIN, WorkspaceRole.OWNER)
  async setKillSwitch(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
    @Body() body: SetKillSwitchDto,
  ) {
    const status = await this.zoteroService.setKillSwitch(
      workspaceId,
      body,
      userId,
    );
    return { data: status };
  }

  @Get('bindings/:bindingId/storage/quota')
  async getStorageQuota(
    @Param('workspaceId') workspaceId: string,
    @Param('bindingId') bindingId: string,
  ) {
    const quota = await this.zoteroService.getStorageQuota(
      workspaceId,
      bindingId,
    );
    return { data: quota };
  }
}
