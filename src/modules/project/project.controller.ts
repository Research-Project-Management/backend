import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { ProjectService } from './project.service';
import {
  CreateProjectDto,
  UpdateProjectDto,
  AddProjectMemberDto,
  UpdateProjectMemberDto,
  AddColumnDto,
  UpdateColumnDto,
} from './dto/project.dto';
import { JwtAuthGuard, CurrentUser } from '@/modules/iam/authentication';
import {
  WorkspaceRoleGuard,
  WorkspaceRoles,
  ProjectRoleGuard,
  ProjectRoles,
} from '@/modules/iam/authorization';

@ApiTags('Organization')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(JwtAuthGuard)
export class ProjectController {
  constructor(private readonly projectService: ProjectService) {}

  @Get([
    'workspace/:workspaceId/projects',
    'workspace/:workspaceId/project',
    ':workspaceId/projects',
    ':workspaceId/project',
  ])
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  async getProjects(@Param('workspaceId') workspaceId: string) {
    return this.projectService.getProjects(workspaceId);
  }

  @Post([
    'workspace/:workspaceId/projects',
    'workspace/:workspaceId/project',
    ':workspaceId/projects',
    ':workspaceId/project',
  ])
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member')
  async createProject(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CreateProjectDto,
  ) {
    return this.projectService.createProject(workspaceId, userId, dto);
  }

  @Get('project/:projectId')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor', 'commenter', 'viewer')
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
  async getProjectOverview(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.projectService.getProjectOverview(projectId, userId);
  }

  @Put('project/:projectId')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin')
  async updateProject(
    @Param('projectId') projectId: string,
    @Body() dto: UpdateProjectDto,
  ) {
    return this.projectService.updateProject(projectId, dto);
  }

  @Delete('project/:projectId')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin')
  async deleteProject(@Param('projectId') projectId: string) {
    return this.projectService.deleteProject(projectId);
  }

  @Get('project/:projectId/members')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor', 'commenter', 'viewer')
  async getProjectMembers(@Param('projectId') projectId: string) {
    return this.projectService.getProjectMembers(projectId);
  }

  @Post('project/:projectId/members')
  @Put('project/:projectId/add-member')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin')
  async addProjectMember(
    @Param('projectId') projectId: string,
    @Body() dto: AddProjectMemberDto,
  ) {
    return this.projectService.addProjectMember(projectId, dto);
  }

  @Put('project/:projectId/members/:userId')
  @Put('project/:projectId/update-member-role')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin')
  async updateProjectMember(
    @Param('projectId') projectId: string,
    @Param('userId') paramUserId: string,
    @Body() dto: UpdateProjectMemberDto,
  ) {
    const targetUserId = paramUserId || dto.userId || '';
    return this.projectService.updateProjectMember(
      projectId,
      targetUserId,
      dto,
    );
  }

  @Delete('project/:projectId/members/:userId')
  @Put('project/:projectId/remove-member')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin')
  async removeProjectMember(
    @Param('projectId') projectId: string,
    @Param('userId') paramUserId: string,
    @Body() body?: { userId?: string },
  ) {
    const targetUserId = paramUserId || body?.userId;
    return this.projectService.removeProjectMember(projectId, targetUserId!);
  }

  @Post('project/:projectId/columns')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin')
  async addColumn(
    @Param('projectId') projectId: string,
    @Body() dto: AddColumnDto,
  ) {
    return this.projectService.addColumn(projectId, dto);
  }

  @Put('project/:projectId/columns/:columnId')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin')
  async updateColumn(
    @Param('projectId') projectId: string,
    @Param('columnId') columnId: string,
    @Body() dto: UpdateColumnDto,
  ) {
    return this.projectService.updateColumn(projectId, columnId, dto);
  }

  @Delete('project/:projectId/columns/:columnId')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin')
  async deleteColumn(
    @Param('projectId') projectId: string,
    @Param('columnId') columnId: string,
  ) {
    return this.projectService.deleteColumn(projectId, columnId);
  }
}
