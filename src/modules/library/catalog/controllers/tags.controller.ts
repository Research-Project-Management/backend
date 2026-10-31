import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';
import { TagType } from '@prisma/client';
import { JwtAuthGuard, CurrentUser } from '@/modules/identity/auth';
import { ProjectAccessGuard, ProjectRoles } from '@/modules/project/access';
import { normalizeProjectScopeId } from '@/modules/library/core';
import { TagsService } from '@/modules/library/catalog/services/tags.service';
import {
  CreateTagDto,
  UpdateTagDto,
} from '@/modules/library/catalog/dto/tags.dto';

@ApiTags('Library Tags')
@ApiBearerAuth('JWT-auth')
@Controller(['api/v1/library/tags', 'api/v1/projects/:projectId/library/tags'])
@UseGuards(JwtAuthGuard, ProjectAccessGuard)
export class TagController {
  constructor(private readonly tagsService: TagsService) {}

  @Get()
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'List tags in personal or project scope' })
  async getTags(
    @CurrentUser('id') userId: string,
    @Query('includeInactive') includeInactive?: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const projectId = normalizeProjectScopeId(paramProjectId || queryProjectId);
    const tags = await this.tagsService.getTags(userId, {
      includeInactive: includeInactive === 'true',
      projectId,
    });
    return { tags, total: tags.length };
  }

  @Post()
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create or get a tag' })
  async createTag(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateTagDto,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const projectId = normalizeProjectScopeId(
      paramProjectId || queryProjectId || dto?.projectId,
    );
    const tag = await this.tagsService.createOrGetTag(
      userId,
      dto.name,
      dto.color,
      dto.type,
      projectId,
      dto.shortcut,
    );
    return { tag };
  }

  @Put(':tagId')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Update a tag' })
  async updateTag(
    @CurrentUser('id') userId: string,
    @Param('tagId') tagId: string,
    @Body() dto: UpdateTagDto,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const projectId = normalizeProjectScopeId(paramProjectId || queryProjectId);
    const tag = await this.tagsService.updateTag(
      userId,
      tagId,
      {
        name: dto.name,
        color: dto.color,
        type: dto.type,
        shortcut: dto.shortcut,
        expectedVersion: dto.expectedVersion,
      },
      projectId,
    );
    return { tag };
  }

  @Patch(':tagId')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Patch a tag' })
  async patchTag(
    @CurrentUser('id') userId: string,
    @Param('tagId') tagId: string,
    @Body() dto: UpdateTagDto,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    return this.updateTag(userId, tagId, dto, queryProjectId, paramProjectId);
  }

  @Delete('automatic')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Delete all automatic tags' })
  async deleteAutomaticTags(
    @CurrentUser('id') userId: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const projectId = normalizeProjectScopeId(paramProjectId || queryProjectId);
    const res = await this.tagsService.deleteAutomaticTags(userId, projectId);
    return { success: true, ...res };
  }

  @Delete(':tagId')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Delete a tag' })
  async deleteTag(
    @CurrentUser('id') userId: string,
    @Param('tagId') tagId: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const projectId = normalizeProjectScopeId(paramProjectId || queryProjectId);
    await this.tagsService.deleteTag(userId, tagId, projectId);
    return { success: true };
  }

  @Post(':tagId/items/:itemId')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Assign tag to item' })
  async assignTag(
    @CurrentUser('id') userId: string,
    @Param('tagId') tagId: string,
    @Param('itemId') itemId: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const projectId = normalizeProjectScopeId(paramProjectId || queryProjectId);
    await this.tagsService.assignTag(userId, tagId, itemId, projectId);
    return { success: true };
  }

  @Delete(':tagId/items/:itemId')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Remove tag from item' })
  async removeTag(
    @CurrentUser('id') userId: string,
    @Param('tagId') tagId: string,
    @Param('itemId') itemId: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const projectId = normalizeProjectScopeId(paramProjectId || queryProjectId);
    await this.tagsService.removeTag(userId, tagId, itemId, projectId);
    return { success: true };
  }
}
