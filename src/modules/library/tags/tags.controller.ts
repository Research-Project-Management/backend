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
  Query,
} from '@nestjs/common';
import { TagsService } from './tags.service';
import { CreateTagDto } from './dto/tags.dto';
import { JwtAuthGuard } from '../../../modules/iam/authn/guards/jwt-auth.guard';
import { WorkspaceRoleGuard } from '../../../modules/iam/authz/guards/workspace-role.guard';
import { WorkspaceRoles } from '../../../modules/iam/authz/decorators/workspace-roles.decorator';

@Controller([
  'api/v1/workspaces/:workspaceId/library/tags',
  'api/v1/workspace/:workspaceId/library/tags',
  'workspace/:workspaceId/library/tags',
])
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class TagsController {
  constructor(private readonly tagsService: TagsService) {}

  @Get()
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  async getTags(
    @Param('workspaceId') workspaceId: string,
    @Query('includeInactive') includeInactive?: string,
  ) {
    return this.tagsService.getTags(workspaceId, {
      includeInactive: includeInactive === 'true',
    });
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @WorkspaceRoles('owner', 'admin', 'member')
  async createTag(
    @Param('workspaceId') workspaceId: string,
    @Body() body: CreateTagDto,
  ) {
    return this.tagsService.createOrGetTag(
      workspaceId,
      body.name,
      body.color,
      body.type,
    );
  }

  @Delete('automatic')
  @HttpCode(HttpStatus.OK)
  @WorkspaceRoles('owner', 'admin')
  async deleteAutomaticTags(@Param('workspaceId') workspaceId: string) {
    return this.tagsService.deleteAutomaticTags(workspaceId);
  }

  @Delete(':tagId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @WorkspaceRoles('owner', 'admin')
  async deleteTag(
    @Param('workspaceId') workspaceId: string,
    @Param('tagId') tagId: string,
  ) {
    const deleted = await this.tagsService.deleteTag(workspaceId, tagId);
    if (!deleted) {
      throw new NotFoundException(
        `Tag ${tagId} not found in workspace ${workspaceId}`,
      );
    }
  }

  @Post(':tagId/items/:itemId')
  @HttpCode(HttpStatus.CREATED)
  @WorkspaceRoles('owner', 'admin', 'member')
  async assignTag(
    @Param('workspaceId') workspaceId: string,
    @Param('tagId') tagId: string,
    @Param('itemId') itemId: string,
  ) {
    await this.tagsService.assignTag(workspaceId, tagId, itemId);
    return { success: true };
  }

  @Delete(':tagId/items/:itemId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @WorkspaceRoles('owner', 'admin', 'member')
  async removeTag(
    @Param('workspaceId') workspaceId: string,
    @Param('tagId') tagId: string,
    @Param('itemId') itemId: string,
  ) {
    await this.tagsService.removeTag(workspaceId, tagId, itemId);
  }
}
