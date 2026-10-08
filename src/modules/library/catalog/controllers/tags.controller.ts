import {
  Controller,
  Get,
  Post,
  Delete,
  Patch,
  Param,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
  Query,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { CreateTagDto, UpdateTagDto } from '../dto/tags.dto';
import { TagsService } from '../services/tags.service';
import { JwtAuthGuard, CurrentUser } from '@/modules/identity/auth';
import { ProjectRoleGuard, ProjectRoles } from '@/modules/project/access';
import { TagType } from '@prisma/client';

@ApiTags('Library Tags')
@ApiBearerAuth('JWT-auth')
@Controller(['api/v1/library/tags', 'api/v1/projects/:projectId/library/tags'])
@UseGuards(JwtAuthGuard, ProjectRoleGuard)
export class TagController {
  constructor(private readonly tagsService: TagsService) {}

  @Get()
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'List library tags' })
  async getTags(
    @CurrentUser('id') userId: string,
    @Param('projectId') routeProjectId?: string,
    @Query('projectId') queryProjectId?: string,
    @Query('includeInactive') includeInactive?: string,
  ) {
    const projectId = routeProjectId ?? queryProjectId;
    return this.tagsService.getTags(userId, {
      includeInactive: includeInactive === 'true',
      projectId,
    });
  }

  @Post()
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Create or retrieve an existing tag' })
  async createTag(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateTagDto,
    @Param('projectId') routeProjectId?: string,
    @Query('projectId') queryProjectId?: string,
  ) {
    const projectId = routeProjectId ?? queryProjectId;
    return this.tagsService.createOrGetTag(
      userId,
      dto.name,
      dto.color,
      dto.type,
      projectId,
    );
  }

  @Patch(':id')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  async updateTag(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: UpdateTagDto,
  ) {
    return this.tagsService.updateTag(userId, id, {
      ...dto,
      type: dto.type as TagType | undefined,
    });
  }

  @Delete('automatic')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Delete all automatic tags' })
  async deleteAutomaticTags(
    @CurrentUser('id') userId: string,
    @Param('projectId') routeProjectId?: string,
    @Query('projectId') queryProjectId?: string,
  ) {
    const projectId = routeProjectId ?? queryProjectId;
    return this.tagsService.deleteAutomaticTags(userId, projectId);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Delete a tag' })
  async deleteTag(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.tagsService.deleteTag(userId, id);
  }

  @Post([':tagId/items/:itemId', 'items/:itemId/assign'])
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Assign a tag to an item' })
  async assignTag(
    @CurrentUser('id') userId: string,
    @Param('itemId') itemId: string,
    @Param('tagId') paramTagId?: string,
    @Body() body?: { tagId?: string; type?: string },
  ) {
    const effectiveTagId = paramTagId || body?.tagId;
    if (!effectiveTagId) {
      throw new BadRequestException('tagId is required');
    }
    return this.tagsService.assignTagToItem(
      userId,
      itemId,
      effectiveTagId,
      body?.type as TagType | undefined,
    );
  }

  @Delete([':tagId/items/:itemId', 'items/:itemId/tags/:tagId'])
  @HttpCode(HttpStatus.NO_CONTENT)
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Detach a tag from an item' })
  async detachTag(
    @CurrentUser('id') userId: string,
    @Param('itemId') itemId: string,
    @Param('tagId') tagId: string,
  ) {
    return this.tagsService.detachTagFromItem(userId, itemId, tagId);
  }
}
