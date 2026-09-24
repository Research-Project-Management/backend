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
  Optional,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { TagsService } from '../application/services/tags.service';
import { CreateTagDto } from '../application/dtos/tags.dto';
import { ListTagsUseCase } from '../application/queries/list-tags.use-case';
import { CreateTagUseCase } from '../application/commands/create-tag.use-case';
import { DeleteTagUseCase } from '../application/commands/delete-tag.use-case';
import { DeleteAutomaticTagsUseCase } from '../application/commands/delete-automatic-tags.use-case';
import { AssignTagUseCase } from '../application/commands/assign-tag.use-case';
import { DetachTagUseCase } from '../application/commands/detach-tag.use-case';
import { JwtAuthGuard, CurrentUser } from '@/modules/identity/auth';
import { ProjectRoleGuard, ProjectRoles } from '@/modules/project/access';

@ApiTags('Library Tags')
@ApiBearerAuth('JWT-auth')
@Controller(['api/v1/library/tags', 'api/v1/projects/:projectId/library/tags'])
@UseGuards(JwtAuthGuard, ProjectRoleGuard)
export class TagsController {
  constructor(
    @Optional() private readonly tagsService?: TagsService,
    @Optional() private readonly listTagsUseCase?: ListTagsUseCase,
    @Optional() private readonly createTagUseCase?: CreateTagUseCase,
    @Optional() private readonly deleteTagUseCase?: DeleteTagUseCase,
    @Optional()
    private readonly deleteAutomaticTagsUseCase?: DeleteAutomaticTagsUseCase,
    @Optional() private readonly assignTagUseCase?: AssignTagUseCase,
    @Optional() private readonly detachTagUseCase?: DetachTagUseCase,
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
    if (this.listTagsUseCase) {
      return this.listTagsUseCase.execute({
        userId,
        options: {
          includeInactive: includeInactive === 'true',
          projectId,
        },
      });
    }
    return this.tagsService!.getTags(userId, {
      includeInactive: includeInactive === 'true',
      projectId,
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
    if (this.createTagUseCase) {
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
    return this.tagsService!.createOrGetTag(
      userId,
      body.name,
      body.color,
      body.type,
      projectId,
    );
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
    if (this.deleteAutomaticTagsUseCase) {
      return this.deleteAutomaticTagsUseCase.execute({ userId, projectId });
    }
    return this.tagsService!.deleteAutomaticTags(userId, projectId);
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
    const deleted = this.deleteTagUseCase
      ? await this.deleteTagUseCase.execute({ userId, tagId, projectId })
      : await this.tagsService!.deleteTag(userId, tagId, projectId);
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
    if (this.assignTagUseCase) {
      return this.assignTagUseCase.execute({ userId, tagId, itemId });
    }
    await this.tagsService!.assignTag(userId, tagId, itemId);
    return { success: true };
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
    if (this.detachTagUseCase) {
      await this.detachTagUseCase.execute({ userId, tagId, itemId });
      return;
    }
    await this.tagsService!.removeTag(userId, tagId, itemId);
  }
}
