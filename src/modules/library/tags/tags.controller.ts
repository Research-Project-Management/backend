import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import { TagsService } from './tags.service';
import { CreateTagDto } from './dto/create-tag.dto';
import { JwtAuthGuard } from '../../../modules/iam/authn/guards/jwt-auth.guard';
import { WorkspaceRoleGuard } from '../../../modules/iam/authz/guards/workspace-role.guard';
import { CurrentWorkspace } from '../../../modules/iam/authz/decorators/current-workspace.decorator';

@Controller([
  'api/v1/workspaces/:workspaceId/library/tags',
  'workspace/:workspaceId/library/tags',
])
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class TagsController {
  constructor(private readonly tagsService: TagsService) {}

  @Get()
  async getTags(
    @Param('workspaceId') workspaceId: string,
    @CurrentWorkspace() currentWorkspaceId?: string,
  ) {
    const targetWsId = currentWorkspaceId || workspaceId;
    return this.tagsService.getTags(targetWsId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createTag(
    @Param('workspaceId') workspaceId: string,
    @Body() body: CreateTagDto,
    @CurrentWorkspace() currentWorkspaceId?: string,
  ) {
    const targetWsId = currentWorkspaceId || workspaceId;
    return this.tagsService.createOrGetTag(
      targetWsId,
      body.name,
      body.color,
      body.type,
    );
  }

  @Delete(':tagId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteTag(
    @Param('workspaceId') workspaceId: string,
    @Param('tagId') tagId: string,
    @CurrentWorkspace() currentWorkspaceId?: string,
  ) {
    const targetWsId = currentWorkspaceId || workspaceId;
    const deleted = await this.tagsService.deleteTag(targetWsId, tagId);
    if (!deleted) {
      throw new NotFoundException(
        `Tag ${tagId} not found in workspace ${targetWsId}`,
      );
    }
  }

  @Post(':tagId/items/:itemId')
  @HttpCode(HttpStatus.CREATED)
  async assignTag(
    @Param('workspaceId') workspaceId: string,
    @Param('tagId') tagId: string,
    @Param('itemId') itemId: string,
    @CurrentWorkspace() currentWorkspaceId?: string,
  ) {
    const targetWsId = currentWorkspaceId || workspaceId;
    await this.tagsService.assignTag(targetWsId, tagId, itemId);
    return { success: true };
  }

  @Delete(':tagId/items/:itemId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeTag(
    @Param('workspaceId') workspaceId: string,
    @Param('tagId') tagId: string,
    @Param('itemId') itemId: string,
    @CurrentWorkspace() currentWorkspaceId?: string,
  ) {
    const targetWsId = currentWorkspaceId || workspaceId;
    await this.tagsService.removeTag(targetWsId, tagId, itemId);
  }
}
