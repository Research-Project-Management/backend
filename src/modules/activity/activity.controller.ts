import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { ActivityService } from './activity.service';
import { JwtAuthGuard } from '@/modules/iam/authentication';
import { CurrentUser } from '@/modules/iam/authentication';
import { EntityType } from '@prisma/client';

@ApiTags('Activity')
@ApiBearerAuth('JWT-auth')
@Controller('api/activity')
@UseGuards(JwtAuthGuard)
export class ActivityController {
  constructor(private readonly activityService: ActivityService) {}

  @Get('tasks/:taskId')
  @ApiOperation({ summary: 'Get task specific activity timeline (Plane.so style)' })
  async getTaskActivity(
    @Param('taskId') taskId: string,
    @Query('limit') limit?: string,
  ) {
    return this.activityService.getTaskActivity(
      taskId,
      limit ? parseInt(limit, 10) : 50,
    );
  }

  @Get('entities/:entityType/:entityId')
  @ApiOperation({ summary: 'Get entity specific activity timeline' })
  async getEntityActivity(
    @Param('entityType') entityType: EntityType,
    @Param('entityId') entityId: string,
    @Query('limit') limit?: string,
  ) {
    return this.activityService.getEntityActivity(
      entityType,
      entityId,
      limit ? parseInt(limit, 10) : 50,
    );
  }

  @Get('workspaces/:workspaceId/feed')
  @ApiOperation({ summary: 'Get workspace collaboration activity feed' })
  async getWorkspaceActivityFeed(
    @Param('workspaceId') workspaceId: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('entityType') entityType?: EntityType,
  ) {
    return this.activityService.getActivityFeed(workspaceId, {
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
      entityType,
    });
  }

  @Get('workspaces/:workspaceId/recent')
  @ApiOperation({ summary: 'Get user recent interacted items' })
  async getRecentItems(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
    @Query('limit') limit?: string,
  ) {
    return this.activityService.getRecentItems(
      workspaceId,
      userId,
      limit ? parseInt(limit, 10) : 10,
    );
  }

  @Get('projects/:projectId/feed')
  @ApiOperation({ summary: 'Get project specific activity feed' })
  async getProjectActivityFeed(
    @Param('projectId') projectId: string,
    @Query('workspaceId') workspaceId: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.activityService.getActivityFeed(workspaceId, {
      projectId,
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }
}
