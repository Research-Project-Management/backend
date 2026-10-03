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
  NotFoundException,
  Query,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { TagsService } from './core/services/tags.service';
import { CreateTagDto, UpdateTagDto } from './dto/tags.dto';
import { ListTagsUseCase } from './core/use-cases/list-tags.use-case';
import { CreateTagUseCase } from './core/use-cases/create-tag.use-case';
import { DeleteTagUseCase } from './core/use-cases/delete-tag.use-case';
import { DeleteAutomaticTagsUseCase } from './core/use-cases/delete-automatic-tags.use-case';
import { AssignTagUseCase } from './core/use-cases/assign-tag.use-case';
import { DetachTagUseCase } from './core/use-cases/detach-tag.use-case';
import { JwtAuthGuard, CurrentUser } from '@/modules/identity/auth';
import { ProjectRoleGuard, ProjectRoles } from '@/modules/project/access';

@ApiTags('Library Tags')
@ApiBearerAuth('JWT-auth')
@Controller(['api/v1/library/tags', 'api/v1/projects/:projectId/library/tags'])
@UseGuards(JwtAuthGuard, ProjectRoleGuard)
export class TagController {
  constructor(
    private readonly listTagsUseCase: ListTagsUseCase,
    private readonly createTagUseCase: CreateTagUseCase,
    private readonly deleteTagUseCase: DeleteTagUseCase,
    private readonly deleteAutomaticTagsUseCase: DeleteAutomaticTagsUseCase,
    private readonly assignTagUseCase: AssignTagUseCase,
    private readonly detachTagUseCase: DetachTagUseCase,
    private readonly tagsService: TagsService,
  ) {}

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
    return this.listTagsUseCase.execute({
      userId,
      options: {
        includeInactive: includeInactive === 'true',
        projectId,
      },
    });
  }

  @Post()
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create or get tag' })
  async createTag(
    @CurrentUser('id') userId: string,
    @Body() body: CreateTagDto,
    @Param('projectId') routeProjectId?: string,
  ) {
    const projectId = routeProjectId ?? body.projectId;
    return this.createTagUseCase.execute({
      userId,
      name: body.name,
      options: {
        color: body.color,
        type: body.type,
        projectId,
      },
    });
  }

  @Delete('automatic')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete automatic tags' })
  async deleteAutomaticTags(
    @CurrentUser('id') userId: string,
    @Param('projectId') routeProjectId?: string,
    @Query('projectId') queryProjectId?: string,
  ) {
    const projectId = routeProjectId ?? queryProjectId;
    return this.deleteAutomaticTagsUseCase.execute({ userId, projectId });
  }

  @Patch(':tagId')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update a tag' })
  async updateTag(
    @CurrentUser('id') userId: string,
    @Param('tagId') tagId: string,
    @Body() body: UpdateTagDto,
    @Param('projectId') routeProjectId?: string,
    @Query('projectId') queryProjectId?: string,
  ) {
    const projectId = routeProjectId ?? queryProjectId;
    const updated = await this.tagsService.updateTag(
      userId,
      tagId,
      {
        name: body.name,
        color: body.color,
        type: body.type as any,
      },
      projectId,
    );
    return { success: true, data: updated };
  }

  @Delete(':tagId')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a tag' })
  async deleteTag(
    @CurrentUser('id') userId: string,
    @Param('tagId') tagId: string,
    @Param('projectId') routeProjectId?: string,
    @Query('projectId') queryProjectId?: string,
  ) {
    const projectId = routeProjectId ?? queryProjectId;
    const deleted = await this.deleteTagUseCase.execute({
      userId,
      tagId,
      projectId,
    });
    if (!deleted) {
      throw new NotFoundException(`Tag ${tagId} not found`);
    }
  }

  @Post(':tagId/items/:itemId')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Assign tag to an item' })
  async assignTag(
    @CurrentUser('id') userId: string,
    @Param('tagId') tagId: string,
    @Param('itemId') itemId: string,
  ) {
    return this.assignTagUseCase.execute({ userId, tagId, itemId });
  }

  @Delete(':tagId/items/:itemId')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove tag from an item' })
  async removeTag(
    @CurrentUser('id') userId: string,
    @Param('tagId') tagId: string,
    @Param('itemId') itemId: string,
  ) {
    await this.detachTagUseCase.execute({ userId, tagId, itemId });
  }
}

export const TagsController = TagController;
export type TagsController = TagController;
