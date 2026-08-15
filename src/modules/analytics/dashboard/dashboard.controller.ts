import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { DashboardService } from './dashboard.service';
import { JwtAuthGuard } from '@/core/guards/jwt-auth.guard';
import { CurrentUser } from '@/core/decorators/current-user.decorator';

@ApiTags('Dashboard')
@ApiBearerAuth('JWT-auth')
@Controller('api/dashboard')
@UseGuards(JwtAuthGuard)
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('workspaces/:workspaceId/search')
  async globalSearch(
    @Param('workspaceId') workspaceId: string,
    @Query('q') query: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.dashboardService.globalSearch(workspaceId, query || '', userId);
  }

  @Get('workspaces/:workspaceId/recent')
  async getRecentItems(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.dashboardService.getRecentItems(workspaceId, userId);
  }

  @Get('workspaces/:workspaceId/activity')
  async getActivityFeed(@Param('workspaceId') workspaceId: string) {
    return this.dashboardService.getActivityFeed(workspaceId);
  }

  @Get('projects/:projectId/overview')
  async getProjectOverview(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.dashboardService.getProjectOverview(projectId, userId);
  }

  @Get('workspaces/:workspaceId/overview')
  async getWorkspaceOverview(@Param('workspaceId') workspaceId: string) {
    return this.dashboardService.getWorkspaceOverview(workspaceId);
  }

  @Get(['workspaces/:workspaceId/your-work', 'your-work/:workspaceId'])
  async getYourWork(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.dashboardService.getYourWork(workspaceId, userId);
  }
}
