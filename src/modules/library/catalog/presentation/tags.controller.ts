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
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { TagsService } from '../application/services/tags.service';
import { CreateTagDto } from '../application/dtos/tags.dto';
import { JwtAuthGuard } from '../../../iam/authn/guards/auth.guard';
import { ProjectRoleGuard } from '../../../iam/authz/guards/role.guard';
import { ProjectRoles } from '../../../iam/authz/decorators/role.decorator';
import { CurrentUser } from '../../../iam/authn/decorators/user.decorator';

@ApiTags('Library Tags')
@ApiBearerAuth('JWT-auth')
@Controller(['api/v1/library/tags', 'api/v1/projects/:projectId/library/tags'])
@UseGuards(JwtAuthGuard, ProjectRoleGuard)
export class TagsController {
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
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create or get tag' })
  async createTag(
    @CurrentUser('id') userId: string,
    @Body() body: CreateTagDto,
    @Param('projectId') routeProjectId?: string,
  ) {
    const projectId = routeProjectId ?? body.projectId;
    return this.tagsService.createOrGetTag(
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
  async deleteAutomaticTags(@CurrentUser('id') userId: string) {
    return this.tagsService.deleteAutomaticTags(userId);
  }

  @Delete(':tagId')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a tag' })
  async deleteTag(
    @CurrentUser('id') userId: string,
    @Param('tagId') tagId: string,
  ) {
    const deleted = await this.tagsService.deleteTag(userId, tagId);
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
    await this.tagsService.assignTag(userId, tagId, itemId);
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
    await this.tagsService.removeTag(userId, tagId, itemId);
  }
}
