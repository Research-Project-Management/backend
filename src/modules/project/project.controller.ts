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
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { ProjectService } from './project.service';
import {
  CreateProjectDto,
  UpdateProjectDto,
  AddProjectMemberDto,
  UpdateProjectMemberDto,
  AddColumnDto,
  UpdateColumnDto,
} from './dto/project.dto';
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

  @Get(['project/:projectId/members', 'projects/:projectId/members'])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor', 'commenter', 'viewer')
  @ApiOperation({ summary: 'List project members' })
  async getProjectMembers(@Param('projectId') projectId: string) {
    return this.projectService.getProjectMembers(projectId);
  }

  @Post(['project/:projectId/members', 'projects/:projectId/members'])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin')
  @ApiOperation({ summary: 'Add a member to the project' })
  async addProjectMember(
    @Param('projectId') projectId: string,
    @Body() dto: AddProjectMemberDto,
  ) {
    return this.projectService.addProjectMember(projectId, dto);
  }

  @Put([
    'project/:projectId/members/:userId',
    'projects/:projectId/members/:userId',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin')
  @ApiOperation({ summary: 'Update project member role' })
  async updateProjectMember(
    @Param('projectId') projectId: string,
    @Param('userId') userId: string,
    @Body() dto: UpdateProjectMemberDto,
  ) {
    return this.projectService.updateProjectMember(projectId, userId, dto);
  }

  @Delete([
    'project/:projectId/members/:userId',
    'projects/:projectId/members/:userId',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin')
  @ApiOperation({
    summary: 'Remove a member from the project (single-admin protected)',
  })
  async removeProjectMember(
    @Param('projectId') projectId: string,
    @Param('userId') userId: string,
  ) {
    return this.projectService.removeProjectMember(projectId, userId);
  }

  @Post(['project/:projectId/leave', 'projects/:projectId/leave'])
  @ApiOperation({ summary: 'Leave project (single-admin protected)' })
  async leaveProject(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.projectService.leaveProject(projectId, userId);
  }

  @Get(['project/:projectId/columns', 'projects/:projectId/columns'])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor', 'commenter', 'viewer')
  @ApiOperation({ summary: 'List project columns (task board lanes)' })
  async getColumns(@Param('projectId') projectId: string) {
    return this.projectService.getColumns(projectId);
  }

  @Post(['project/:projectId/columns', 'projects/:projectId/columns'])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin')
  @ApiOperation({ summary: 'Add a new column to the project board' })
  async addColumn(
    @Param('projectId') projectId: string,
    @Body() dto: AddColumnDto,
  ) {
    return this.projectService.addColumn(projectId, dto);
  }

  @Put([
    'project/:projectId/columns/:columnId',
    'projects/:projectId/columns/:columnId',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin')
  @ApiOperation({ summary: 'Update a project board column' })
  async updateColumn(
    @Param('projectId') projectId: string,
    @Param('columnId') columnId: string,
    @Body() dto: UpdateColumnDto,
  ) {
    return this.projectService.updateColumn(projectId, columnId, dto);
  }

  @Delete([
    'project/:projectId/columns/:columnId',
    'projects/:projectId/columns/:columnId',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin')
  @ApiOperation({
    summary: 'Delete a project board column with automatic task migration',
  })
  async deleteColumn(
    @Param('projectId') projectId: string,
    @Param('columnId') columnId: string,
    @Query('fallbackColumnId') fallbackColumnId?: string,
    @CurrentUser('id') userId?: string,
  ) {
    return this.projectService.deleteColumn(
      projectId,
      columnId,
      fallbackColumnId,
      userId,
    );
  }
}
