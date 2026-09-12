import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { AnalyticsService } from './analytics.service';
import { JwtAuthGuard } from '@/modules/iam/authn/guards/jwt-auth.guard';
import { WorkspaceRoleGuard } from '@/modules/iam/authz/guards/workspace-role.guard';
import { WorkspaceRoles } from '@/modules/iam/authz/decorators/workspace-roles.decorator';
import { ProjectRoleGuard } from '@/modules/iam/authz/guards/project-role.guard';
import { ProjectRoles } from '@/modules/iam/authz/decorators/project-roles.decorator';

@ApiTags('Analytics')
@ApiBearerAuth('JWT-auth')
@Controller('api/analytics')
@UseGuards(JwtAuthGuard)
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Get(['projects/:projectId', 'project/:projectId'])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor', 'commenter', 'viewer')
  @ApiOperation({ summary: 'Get project dimensional insights (State, Priority, Assignee)' })
  async getProjectAnalytics(@Param('projectId') projectId: string) {
    return this.analyticsService.getProjectAnalytics(projectId);
  }

  @Get(['cycles/:cycleId', 'cycle/:cycleId'])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor', 'commenter', 'viewer')
  @ApiOperation({ summary: 'Get cycle completion metrics (total, completed, inProgress)' })
  async getCycleAnalytics(@Param('cycleId') cycleId: string) {
    return this.analyticsService.getCycleAnalytics(cycleId);
  }

  @Get(['workspaces/:workspaceId/overview', 'workspace/:workspaceId/overview'])
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  @ApiOperation({ summary: 'Get workspace aggregate metrics overview' })
  async getWorkspaceOverview(@Param('workspaceId') workspaceId: string) {
    return this.analyticsService.getWorkspaceOverview(workspaceId);
  }

  @Get(['projects/:projectId/labels', 'project/:projectId/labels'])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor', 'commenter', 'viewer')
  @ApiOperation({ summary: 'Get task count grouped by label for a project' })
  async getLabelDistribution(@Param('projectId') projectId: string) {
    return this.analyticsService.getLabelDistribution(projectId);
  }

  @Get(['projects/:projectId/timeseries', 'project/:projectId/timeseries'])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor', 'commenter', 'viewer')
  @ApiOperation({ summary: 'Get daily task creation and completion trend' })
  @ApiQuery({ name: 'from', description: 'Start date (ISO 8601)', example: '2026-09-01' })
  @ApiQuery({ name: 'to', description: 'End date (ISO 8601)', example: '2026-09-12' })
  async getTimeSeries(
    @Param('projectId') projectId: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    const fromDate = from || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const toDate = to || new Date().toISOString().slice(0, 10);
    return this.analyticsService.getTimeSeries(projectId, fromDate, toDate);
  }

  @Get(['cycles/:cycleId/burndown', 'cycle/:cycleId/burndown'])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor', 'commenter', 'viewer')
  @ApiOperation({ summary: 'Get daily burn-down chart data for a cycle' })
  async getCycleBurndown(@Param('cycleId') cycleId: string) {
    return this.analyticsService.getCycleBurndown(cycleId);
  }

  @Get(['cycles/:cycleId/velocity', 'cycle/:cycleId/velocity'])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor', 'commenter', 'viewer')
  @ApiOperation({ summary: 'Get story points velocity for a cycle' })
  async getCycleVelocity(@Param('cycleId') cycleId: string) {
    return this.analyticsService.getCycleVelocity(cycleId);
  }
}
