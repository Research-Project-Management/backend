import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '@/modules/identity/auth';
import { ProjectAnalyticsService } from './analytics.service';
import { ProjectRoleGuard, ProjectRoles } from '@/modules/project/access';

@ApiTags('Project Analytics & Portfolio')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller(['api/v1/projects', 'api/projects'])
export class ProjectAnalyticsController {
  constructor(private readonly analyticsService: ProjectAnalyticsService) {}

  @Get(':projectId/analytics')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Get detailed dimensional breakdown for a project' })
  getAnalytics(@Param('projectId') projectId: string) {
    return this.analyticsService.getProjectDetailedBreakdown(projectId);
  }

  @Get(':projectId/analytics/overview')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Get high-level portfolio overview for a project' })
  getOverview(@Param('projectId') projectId: string) {
    return this.analyticsService.getProjectOverview(projectId);
  }

  @Get(':projectId/analytics/timeseries')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Get daily WorkItem creation and completion trend' })
  @ApiQuery({ name: 'from', required: false, example: '2026-09-01' })
  @ApiQuery({ name: 'to', required: false, example: '2026-09-16' })
  getTimeSeries(
    @Param('projectId') projectId: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    const fromDate =
      from ||
      new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);
    const toDate = to || new Date().toISOString().slice(0, 10);
    return this.analyticsService.getTimeSeries(projectId, fromDate, toDate);
  }

  @Get(':projectId/analytics/labels')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Get WorkItem distribution by label for a project' })
  getLabelDistribution(@Param('projectId') projectId: string) {
    return this.analyticsService.getLabelDistribution(projectId);
  }
}
