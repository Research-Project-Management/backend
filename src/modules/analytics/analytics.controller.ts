import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { AnalyticsService } from './analytics.service';
import { JwtAuthGuard } from '@/modules/iam/authentication';
import { CurrentUser } from '@/modules/iam/authentication';

@ApiTags('Analytics')
@ApiBearerAuth('JWT-auth')
@Controller('api/analytics')
@UseGuards(JwtAuthGuard)
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Get('projects/:projectId')
  @ApiOperation({ summary: 'Get project dimensional insights (State, Priority, Assignee)' })
  async getProjectAnalytics(@Param('projectId') projectId: string) {
    return this.analyticsService.getProjectAnalytics(projectId);
  }

  @Get('cycles/:cycleId')
  @ApiOperation({ summary: 'Get cycle burndown and velocity analytics' })
  async getCycleAnalytics(@Param('cycleId') cycleId: string) {
    return this.analyticsService.getCycleAnalytics(cycleId);
  }

  @Get(['your-work/:workspaceId', 'workspaces/:workspaceId/your-work'])
  @ApiOperation({ summary: 'Get user summary workload and metrics' })
  async getYourWork(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.analyticsService.getYourWork(workspaceId, userId);
  }

  @Get('workspaces/:workspaceId/overview')
  @ApiOperation({ summary: 'Get workspace aggregate metrics overview' })
  async getWorkspaceOverview(@Param('workspaceId') workspaceId: string) {
    return this.analyticsService.getWorkspaceOverview(workspaceId);
  }
}
