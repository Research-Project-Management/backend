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
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { ProjectService } from './project.service';
import { CreateProjectDto, UpdateProjectDto } from './dto/project.dto';
import { JwtAuthGuard } from '@/modules/iam/authn/guards/jwt-auth.guard';
import { CurrentUser } from '@/modules/iam/authn/decorators/current-user.decorator';
import { WorkspaceRoleGuard } from '@/modules/iam/authz/guards/workspace-role.guard';
import { WorkspaceRoles } from '@/modules/iam/authz/decorators/workspace-roles.decorator';
import { ProjectRoleGuard } from '@/modules/iam/authz/guards/project-role.guard';
import { ProjectRoles } from '@/modules/iam/authz/decorators/project-roles.decorator';

@ApiTags('Organization')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(JwtAuthGuard)
export class ProjectController {
  constructor(private readonly projectService: ProjectService) {}

  @Get([
    'workspace/:workspaceId/projects',
    'workspace/:workspaceId/project',
    'workspaces/:workspaceId/projects',
    'workspaces/:workspaceId/project',
    ':workspaceId/projects',
    ':workspaceId/project',
  ])
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  @ApiOperation({ summary: 'List all projects in a workspace' })
  async getProjects(@Param('workspaceId') workspaceId: string) {
    return this.projectService.getProjects(workspaceId);
  }

  @Post([
    'workspace/:workspaceId/projects',
    'workspace/:workspaceId/project',
    'workspaces/:workspaceId/projects',
    'workspaces/:workspaceId/project',
    ':workspaceId/projects',
    ':workspaceId/project',
  ])
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member')
  @ApiOperation({ summary: 'Create a new project in a workspace' })
  async createProject(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CreateProjectDto,
  ) {
    return this.projectService.createProject(workspaceId, userId, dto);
  }

  @Get(['project/:projectId', 'projects/:projectId'])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor', 'commenter', 'viewer')
  @ApiOperation({ summary: 'Get a project by ID' })
  async getProject(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.projectService.getProject(projectId, userId);
  }

  @Get([
    'project/:projectId/overview',
    'projects/:projectId/overview',
    'analytics/projects/:projectId/overview',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor', 'commenter', 'viewer')
  @ApiOperation({ summary: 'Get project overview and statistics' })
  async getProjectOverview(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.projectService.getProjectOverview(projectId, userId);
  }

  @Put(['project/:projectId', 'projects/:projectId'])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin')
  @ApiOperation({ summary: 'Update project settings' })
  async updateProject(
    @Param('projectId') projectId: string,
    @Body() dto: UpdateProjectDto,
  ) {
    return this.projectService.updateProject(projectId, dto);
  }

  @Delete(['project/:projectId', 'projects/:projectId'])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin')
  @ApiOperation({ summary: 'Soft-delete a project' })
  async deleteProject(@Param('projectId') projectId: string) {
    return this.projectService.deleteProject(projectId);
  }

  @Post(['project/:projectId/restore', 'projects/:projectId/restore'])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin')
  @ApiOperation({ summary: 'Restore a soft-deleted project' })
  async restoreProject(@Param('projectId') projectId: string) {
    return this.projectService.restoreProject(projectId);
  }

  @Get([
    'workspace/:workspaceId/projects/archived',
    'workspaces/:workspaceId/projects/archived',
    ':workspaceId/projects/archived',
  ])
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  @ApiOperation({ summary: 'List all archived projects in a workspace' })
  async getArchivedProjects(@Param('workspaceId') workspaceId: string) {
    return this.projectService.getArchivedProjects(workspaceId);
  }

  @Patch(['project/:projectId/archive', 'projects/:projectId/archive'])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin')
  @ApiOperation({ summary: 'Archive a project (freezes data and hides from active lists)' })
  async archiveProject(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.projectService.archiveProject(projectId, userId);
  }

  @Patch([
    'project/:projectId/unarchive',
    'projects/:projectId/unarchive',
    'project/:projectId/restore-archive',
    'projects/:projectId/restore-archive',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin')
  @ApiOperation({ summary: 'Unarchive/restore a project to active status' })
  async unarchiveProject(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.projectService.unarchiveProject(projectId, userId);
  }
}
