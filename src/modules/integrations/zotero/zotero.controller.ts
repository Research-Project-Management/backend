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
import { JwtAuthGuard } from '../../iam/authn/guards/auth.guard';
import { CurrentUser } from '../../iam/authn/decorators/user.decorator';
import { ZoteroService } from './zotero.service';
import { SetKillSwitchDto } from './dto/set-kill-switch.dto';
import {
  CreateZoteroConnectionDto,
  CreateZoteroBindingDto,
} from './dto/zotero-connection.dto';
import { UpdateZoteroSyncDirectionDto } from './dto/update-zotero-sync-direction.dto';
import { ResolveZoteroConflictDto } from './dto/resolve-zotero-conflict.dto';

@Controller([
  'api/v1/library/integrations/zotero',
  'api/v1/workspaces/:workspaceId/library/integrations/zotero',
])
@UseGuards(JwtAuthGuard)
export class ZoteroController {
  constructor(private readonly zoteroService: ZoteroService) {}

  @Post('connections')
  async createConnection(
    @CurrentUser('id') userId: string,
    @Body() body: CreateZoteroConnectionDto,
  ) {
    const connection = await this.zoteroService.createConnection(
      userId,
      userId,
      body,
    );
    return { data: connection };
  }

  @Get('connections')
  async listConnections(@CurrentUser('id') userId: string) {
    const data = await this.zoteroService.listConnections(userId);
    return { data };
  }

  @Get('connections/:connectionId')
  async getConnection(
    @CurrentUser('id') userId: string,
    @Param('connectionId') connectionId: string,
  ) {
    const data = await this.zoteroService.getConnection(
      userId,
      connectionId,
    );
    return { data };
  }

  @Delete('connections/:connectionId')
  async revokeConnection(
    @CurrentUser('id') userId: string,
    @Param('connectionId') connectionId: string,
  ) {
    const res = await this.zoteroService.revokeConnection(
      userId,
      connectionId,
    );
    return { data: res };
  }

  @Get('connections/:connectionId/libraries')
  async listRemoteLibraries(
    @CurrentUser('id') userId: string,
    @Param('connectionId') connectionId: string,
  ) {
    const libraries = await this.zoteroService.listRemoteLibraries(
      userId,
      connectionId,
    );
    return { data: libraries };
  }

  @Post('bindings')
  async createBinding(
    @CurrentUser('id') userId: string,
    @Body() body: CreateZoteroBindingDto,
  ) {
    const binding = await this.zoteroService.createBinding(userId, body);
    return {
      data: {
        ...binding,
        lastSyncVersion: binding.lastSyncVersion.toString(),
      },
    };
  }

  @Get('bindings')
  async listBindings(
    @CurrentUser('id') userId: string,
    @Query('connectionId') connectionId?: string,
  ) {
    const bindings = await this.zoteroService.listBindings(
      userId,
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
  async updateSyncDirection(
    @CurrentUser('id') userId: string,
    @Param('bindingId') bindingId: string,
    @Body() body: UpdateZoteroSyncDirectionDto,
  ) {
    const updated = await this.zoteroService.updateBindingSyncDirection(
      userId,
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
  async triggerPull(
    @CurrentUser('id') userId: string,
    @Param('bindingId') bindingId: string,
  ) {
    const result = await this.zoteroService.executePull(userId, bindingId);
    return {
      data: {
        ...result,
        versionAfter: result.versionAfter.toString(),
      },
    };
  }

  @Post('bindings/:bindingId/reconcile')
  async triggerReconcile(
    @CurrentUser('id') userId: string,
    @Param('bindingId') bindingId: string,
  ) {
    const result = await this.zoteroService.executeReconciliation(
      userId,
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
  async pushItem(
    @CurrentUser('id') userId: string,
    @Param('bindingId') bindingId: string,
    @Param('itemId') itemId: string,
  ) {
    const result = await this.zoteroService.executePush(
      userId,
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
  async listWorkspaceConflicts(@CurrentUser('id') userId: string) {
    const data = await this.zoteroService.listConflicts(userId);
    return { data };
  }

  @Get('bindings/:bindingId/conflicts')
  async listBindingConflicts(
    @CurrentUser('id') userId: string,
    @Param('bindingId') bindingId: string,
  ) {
    const data = await this.zoteroService.listConflicts(userId, bindingId);
    return { data };
  }

  @Get('bindings/:bindingId/pending-pushes')
  async listPendingPushes(
    @CurrentUser('id') userId: string,
    @Param('bindingId') bindingId: string,
  ) {
    const data = await this.zoteroService.listPendingPushes(
      userId,
      bindingId,
    );
    return { data };
  }

  @Post('bindings/:bindingId/conflicts/:itemId/resolve')
  async resolveConflict(
    @CurrentUser('id') userId: string,
    @Param('bindingId') bindingId: string,
    @Param('itemId') itemId: string,
    @Body() body: ResolveZoteroConflictDto,
  ) {
    const result = await this.zoteroService.resolveConflict(
      userId,
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
  async getKillSwitchStatus(@CurrentUser('id') userId: string) {
    const status = await this.zoteroService.getKillSwitchStatus(userId);
    return { data: status };
  }

  @Post('kill-switch')
  async setKillSwitch(
    @CurrentUser('id') userId: string,
    @Body() body: SetKillSwitchDto,
  ) {
    const status = await this.zoteroService.setKillSwitch(
      userId,
      body,
      userId,
    );
    return { data: status };
  }

  @Get('bindings/:bindingId/storage/quota')
  async getStorageQuota(
    @CurrentUser('id') userId: string,
    @Param('bindingId') bindingId: string,
  ) {
    const quota = await this.zoteroService.getStorageQuota(
      userId,
      bindingId,
    );
    return { data: quota };
  }
}
