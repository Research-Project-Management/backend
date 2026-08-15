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
import { JwtAuthGuard } from '@/core/guards/jwt-auth.guard';
import { WorkspaceRoleGuard } from '@/core/guards/workspace-role.guard';
import { Roles } from '@/core/decorators/roles.decorator';
import { CurrentUser } from '@/core/decorators/current-user.decorator';

@ApiTags('Organization')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(JwtAuthGuard)
export class ProjectController {
  constructor(private readonly projectService: ProjectService) {}

  @Get('workspace/:workspaceId/projects')
  @UseGuards(WorkspaceRoleGuard)
  @Roles('owner', 'admin', 'member', 'viewer')
  async getProjects(@Param('workspaceId') workspaceId: string) {
    return this.projectService.getProjects(workspaceId);
  }

  @Post('workspace/:workspaceId/projects')
  @Post('workspace/:workspaceId/project')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(WorkspaceRoleGuard)
  @Roles('owner', 'admin', 'member')
  async createProject(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CreateProjectDto,
  ) {
    return this.projectService.createProject(workspaceId, userId, dto);
  }

  @Get('project/:projectId')
  async getProject(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.projectService.getProject(projectId, userId);
  }

  @Put('project/:projectId')
  async updateProject(
    @Param('projectId') projectId: string,
    @Body() dto: UpdateProjectDto,
  ) {
    return this.projectService.updateProject(projectId, dto);
  }

  @Delete('project/:projectId')
  async deleteProject(@Param('projectId') projectId: string) {
    return this.projectService.deleteProject(projectId);
  }

  @Get('project/:projectId/members')
  async getProjectMembers(@Param('projectId') projectId: string) {
    return this.projectService.getProjectMembers(projectId);
  }

  @Post('project/:projectId/members')
  @Put('project/:projectId/add-member')
  async addProjectMember(
    @Param('projectId') projectId: string,
    @Body() dto: AddProjectMemberDto,
  ) {
    return this.projectService.addProjectMember(projectId, dto);
  }

  @Put('project/:projectId/members/:userId')
  @Put('project/:projectId/update-member-role')
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
  async removeProjectMember(
    @Param('projectId') projectId: string,
    @Param('userId') paramUserId: string,
    @Body() body?: { userId?: string },
  ) {
    const targetUserId = paramUserId || body?.userId;
    return this.projectService.removeProjectMember(projectId, targetUserId!);
  }

  @Post('project/:projectId/columns')
  async addColumn(
    @Param('projectId') projectId: string,
    @Body() dto: AddColumnDto,
  ) {
    return this.projectService.addColumn(projectId, dto);
  }

  @Put('project/:projectId/columns/:columnId')
  async updateColumn(
    @Param('projectId') projectId: string,
    @Param('columnId') columnId: string,
    @Body() dto: UpdateColumnDto,
  ) {
    return this.projectService.updateColumn(projectId, columnId, dto);
  }

  @Delete('project/:projectId/columns/:columnId')
  async deleteColumn(
    @Param('projectId') projectId: string,
    @Param('columnId') columnId: string,
  ) {
    return this.projectService.deleteColumn(projectId, columnId);
  }
}
