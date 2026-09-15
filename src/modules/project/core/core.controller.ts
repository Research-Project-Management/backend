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
  ProjectResponseDto,
  ProjectDetailResponseDto,
  ProjectListResponseDto,
} from './dto/response.dto';
import { JwtAuthGuard } from '@/modules/iam/authn/guards/auth.guard';
import { CurrentUser } from '@/modules/iam/authn/decorators/user.decorator';
import { ProjectRoleGuard } from '@/modules/iam/authz/guards/role.guard';
import { ProjectRoles } from '@/modules/iam/authz/decorators/role.decorator';

import { AnalyticsService } from '@/modules/analytics/analytics.service';

@ApiTags('Projects')
@ApiBearerAuth('JWT-auth')
@Controller(['api/projects', 'api/project'])
@UseGuards(JwtAuthGuard)
export class CoreController {
  constructor(
    private readonly projectService: CoreService,
    private readonly analyticsService: AnalyticsService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'List user projects (My Projects & Shared with Me)',
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

  @Get('archived')
  @ApiOperation({ summary: 'List all archived projects for current user' })
  @ApiResponse({
    status: 200,
    description: 'List of archived projects',
    type: [ProjectResponseDto],
  })
  async getArchivedProjects(@CurrentUser('id') userId: string) {
    return this.projectService.findArchived(userId);
  }

  @Get('analytics')
  @ApiOperation({
    summary: 'Get project analytics via query parameter or user overview',
  })
  async getProjectAnalyticsByQuery(
    @Query('projectId') projectId?: string,
    @CurrentUser('id') userId?: string,
  ) {
    if (projectId) {
      return this.analyticsService.getProjectAnalytics(projectId);
    }
    return this.analyticsService.getUserOverview(userId || '');
  }

  @Get(':projectId/analytics')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'contributor', 'commenter', 'viewer')
  @ApiOperation({ summary: 'Get project dimensional insights and analytics' })
  async getProjectAnalytics(@Param('projectId') projectId: string) {
    return this.analyticsService.getProjectAnalytics(projectId);
  }

  @Get(':projectId')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'contributor', 'commenter', 'viewer')
  @ApiOperation({ summary: 'Get a project by ID' })
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

  @Get(':projectId/overview')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'contributor', 'commenter', 'viewer')
  @ApiOperation({ summary: 'Get project overview and statistics' })
  @ApiResponse({
    status: 200,
    description: 'Project dashboard metrics and stats',
  })
  async getProjectOverview(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.projectService.findOverview(projectId, userId);
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

  @Patch(':projectId/archive')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner')
  @ApiOperation({
    summary: 'Archive a project (freezes data and hides from active lists)',
  })
  @ApiResponse({
    status: 200,
    description: 'Project archived successfully',
  })
  async archiveProject(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.projectService.archive(projectId, userId);
  }

  @Patch([':projectId/unarchive', ':projectId/restore-archive'])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner')
  @ApiOperation({ summary: 'Unarchive/restore a project to active status' })
  @ApiResponse({
    status: 200,
    description: 'Project unarchived successfully',
  })
  async unarchiveProject(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.projectService.unarchive(projectId, userId);
  }
}

export { CoreController as ProjectController };
