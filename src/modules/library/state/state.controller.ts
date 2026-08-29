import {
  Controller,
  Get,
  Patch,
  Post,
  Param,
  Body,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../../modules/iam/authn/guards/jwt-auth.guard';
import { WorkspaceRoleGuard } from '../../../modules/iam/authz/guards/workspace-role.guard';
import { CurrentUser } from '../../../modules/iam/authn/decorators/current-user.decorator';
import { StateService } from './state.service';
import { UpdateStateDto } from './dto/state.dto';

@Controller([
  'api/v1/workspaces/:workspaceId/library/items/:itemId/state',
  'api/library/papers/:workspaceId/:itemId/state',
  'api/library/items/:workspaceId/:itemId/state',
])
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class StateController {
  constructor(private readonly stateService: StateService) {}

  @Get()
  async getState(
    @Param('workspaceId') workspaceId: string,
    @Param('itemId') itemId: string,
    @CurrentUser('id') userId: string,
  ) {
    const data = await this.stateService.getState(workspaceId, itemId, userId);
    return {
      success: true,
      data,
    };
  }

  @Patch()
  async updateState(
    @Param('workspaceId') workspaceId: string,
    @Param('itemId') itemId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: UpdateStateDto,
  ) {
    const data = await this.stateService.updateState(
      workspaceId,
      itemId,
      userId,
      dto,
    );
    return {
      success: true,
      data,
    };
  }

  @Post('read')
  async markAsRead(
    @Param('workspaceId') workspaceId: string,
    @Param('itemId') itemId: string,
    @CurrentUser('id') userId: string,
  ) {
    const data = await this.stateService.markAsRead(
      workspaceId,
      itemId,
      userId,
    );
    return {
      success: true,
      data,
    };
  }

  @Post('batch')
  async getBatchStates(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
    @Body() body: { itemIds: string[] },
  ) {
    const data = await this.stateService.getBatchStates(
      workspaceId,
      body.itemIds || [],
      userId,
    );
    return {
      success: true,
      data,
    };
  }
}
