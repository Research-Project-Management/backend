import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
} from '@nestjs/swagger';
import { CoreService } from './core.service';
import { CreateProjectDto } from './dto/create.dto';
import { UpdateProjectDto } from './dto/update.dto';
import { ProjectQueryDto } from './dto/query.dto';
import {
  ProjectDetailResponseDto,
  ProjectListResponseDto,
} from './dto/response.dto';
import { JwtAuthGuard } from '@/modules/identity/auth';
import { CurrentUser } from '@/modules/identity/auth';
import { ProjectRoleGuard, ProjectRoles } from '@/modules/project/access';

/**
 * Core Controller for Project Aggregate Root.
 * Coordinates basic CRUD and lifecycle management.
 * Specialized sub-domains (State, Label, Template, Archive, Analytics, Favorite)
 * are handled by their respective dedicated sub-modules.
 */
@ApiTags('Projects')
@ApiBearerAuth('JWT-auth')
@Controller(['api/v1/projects', 'api/projects'])
@UseGuards(JwtAuthGuard)
export class CoreController {
  constructor(private readonly projectService: CoreService) {}

  @Get()
  @ApiOperation({
    summary:
      'List user projects (My Projects & Shared with Me) with multi-dimensional filtering',
  })
  @ApiResponse({
    status: 200,
    description: 'List of projects accessible by the current user',
    type: ProjectListResponseDto,
  })
  async getUserProjects(
    @CurrentUser('id') userId: string,
    @Query() query: ProjectQueryDto,
  ) {
    return this.projectService.findUserProjects(userId, query);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new project for current user' })
  @ApiResponse({
    status: 201,
    description: 'Project created successfully',
    type: ProjectDetailResponseDto,
  })
  async createProject(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateProjectDto,
  ) {
    return this.projectService.create(userId, dto);
  }

  @Get(':projectId')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Get project detail by ID' })
  @ApiResponse({
    status: 200,
    description: 'Project details',
    type: ProjectDetailResponseDto,
  })
  async getProject(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.projectService.findById(projectId, userId);
  }

  @Put(':projectId')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner')
  @ApiOperation({ summary: 'Update project settings (Owner only)' })
  @ApiResponse({
    status: 200,
    description: 'Project updated successfully',
    type: ProjectDetailResponseDto,
  })
  async updateProject(
    @Param('projectId') projectId: string,
    @CurrentUser('id') actorId: string,
    @Body() dto: UpdateProjectDto,
  ) {
    return this.projectService.update(projectId, dto, actorId);
  }

  @Delete(':projectId')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner')
  @ApiOperation({ summary: 'Soft-delete a project (Owner only)' })
  @ApiResponse({
    status: 200,
    description: 'Project soft-deleted successfully',
  })
  async deleteProject(
    @Param('projectId') projectId: string,
    @CurrentUser('id') actorId: string,
  ) {
    return this.projectService.softDelete(projectId, actorId);
  }

  @Post(':projectId/restore')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner')
  @ApiOperation({ summary: 'Restore a soft-deleted project (Owner only)' })
  @ApiResponse({
    status: 200,
    description: 'Project restored successfully',
  })
  async restoreProject(
    @Param('projectId') projectId: string,
    @CurrentUser('id') actorId: string,
  ) {
    return this.projectService.restore(projectId, actorId);
  }
}

export { CoreController as ProjectController };
