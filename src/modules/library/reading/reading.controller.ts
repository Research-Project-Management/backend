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
import { ReadingService } from './reading.service';
import { UpdateReadingDto } from './dto/update-reading.dto';

@Controller([
  'api/v1/workspaces/:workspaceId/library/items/:itemId/state',
  'api/library/papers/:workspaceId/:itemId/state',
  'api/library/items/:workspaceId/:itemId/state',
])
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class ReadingController {
  constructor(private readonly readingService: ReadingService) {}

  @Get()
  async getState(
    @Param('workspaceId') workspaceId: string,
    @Param('itemId') itemId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.readingService.getState(
      workspaceId,
      itemId,
      userId,
    );
  }

  @Patch()
  async updateState(
    @Param('workspaceId') workspaceId: string,
    @Param('itemId') itemId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: UpdateReadingDto,
  ) {
    return this.readingService.updateState(
      workspaceId,
      itemId,
      userId,
      dto,
    );
  }

  @Post('read')
  async markAsRead(
    @Param('workspaceId') workspaceId: string,
    @Param('itemId') itemId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.readingService.markAsRead(
      workspaceId,
      itemId,
      userId,
    );
  }

  @Post('batch')
  async getBatchStates(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
    @Body() body: { itemIds: string[] },
  ) {
    return this.readingService.getBatchStates(
      workspaceId,
      body.itemIds || [],
      userId,
    );
  }
}
