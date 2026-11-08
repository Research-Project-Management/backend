import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
} from '@nestjs/swagger';
import { AnalyticsService } from './analytics.service';
import { JwtAuthGuard, CurrentUser } from '@/modules/identity/auth';
import { ProjectAccessGuard, ProjectRoles } from '@/modules/project/access';

@ApiTags('Project Analytics')
@ApiBearerAuth('JWT-auth')
@Controller(['api/v1/analytics', 'api/analytics', 'api/v1/projects', 'api/projects'])
@UseGuards(JwtAuthGuard)
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Get([
    'projects/:projectId/analytics',
    'project/:projectId/analytics',
    ':projectId/analytics',
    ':projectId/analytics/insights',
  ])
  @UseGuards(ProjectAccessGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({
    summary:
      'Get project dimensional insights (KPIs, State Groups, Columns, Priority, Assignee Workload, Labels)',
  })
  async getProjectAnalytics(@Param('projectId') projectId: string) {
    return this.analyticsService.getProjectAnalytics(projectId);
  }

  @Get([
    'projects/:projectId/analytics/overview',
    ':projectId/analytics/overview',
  ])
  @UseGuards(ProjectAccessGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Get project aggregate entity counts' })
  async getProjectOverview(@Param('projectId') projectId: string) {
    return this.analyticsService.getProjectOverview(projectId);
  }

  @Get(['me/overview', 'overview'])
  @ApiOperation({ summary: 'Get user personal aggregate metrics overview' })
  async getUserOverview(@CurrentUser('id') userId: string) {
    return this.analyticsService.getUserOverview(userId);
  }

  @Get([
    'projects/:projectId/analytics/labels',
    ':projectId/analytics/labels',
  ])
  @UseGuards(ProjectAccessGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({
    summary: 'Get WorkItem count grouped by label for a project',
  })
  async getLabelDistribution(@Param('projectId') projectId: string) {
    return this.analyticsService.getLabelDistribution(projectId);
  }

  @Get([
    'projects/:projectId/analytics/timeseries',
    'projects/:projectId/timeseries',
    'project/:projectId/timeseries',
    ':projectId/analytics/timeseries',
    ':projectId/timeseries',
  ])
  @UseGuards(ProjectAccessGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Get daily WorkItem creation and completion trend' })
  @ApiQuery({
    name: 'from',
    required: false,
    description: 'Start date (ISO 8601)',
    example: '2026-09-01',
  })
  @ApiQuery({
    name: 'to',
    required: false,
    description: 'End date (ISO 8601)',
    example: '2026-09-30',
  })
  async getTimeSeries(
    @Param('projectId') projectId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const fromDate =
      from ||
      new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);
    const toDate = to || new Date().toISOString().slice(0, 10);
    return this.analyticsService.getTimeSeries(projectId, fromDate, toDate);
  }
}
