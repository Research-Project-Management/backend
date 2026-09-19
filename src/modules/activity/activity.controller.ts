import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { ActivityService } from './activity.service';
import { JwtAuthGuard } from '@/modules/iam/authn/guards/auth.guard';
import { CurrentUser } from '@/modules/iam/authn/decorators/user.decorator';
import { ProjectRoleGuard } from '@/modules/iam/authz/guards/role.guard';
import { ProjectRoles } from '@/modules/iam/authz/decorators/role.decorator';
import { EntityType } from '@prisma/client';

@ApiTags('Activity')
@ApiBearerAuth('JWT-auth')
@Controller()
@UseGuards(JwtAuthGuard)
export class ActivityController {
  constructor(private readonly activityService: ActivityService) {}

  @Get(['api/activity/feed', 'activity/feed', 'api/me/feed', 'me/feed'])
  @ApiOperation({ summary: 'Get collaboration activity feed' })
  async getActivityFeed(
    @CurrentUser('id') userId: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('entityType') entityType?: EntityType,
  ) {
    return this.activityService.getUserFeed(userId, {
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
      entityType,
    });
  }

  @Get(['api/activity/recent', 'activity/recent', 'api/me/recent', 'me/recent'])
  @ApiOperation({ summary: 'Get user recent interacted items' })
  async getRecentItems(
    @CurrentUser('id') userId: string,
    @Query('limit') limit?: string,
  ) {
    return this.activityService.getRecentItems(
      undefined,
      userId,
      limit ? parseInt(limit, 10) : 10,
    );
  }

  @Get([
    'api/activity/projects/:projectId/feed',
    'activity/projects/:projectId/feed',
    'api/projects/:projectId/activity/feed',
    'projects/:projectId/activity/feed',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Get project specific activity feed' })
  async getProjectActivityFeed(
    @Param('projectId') projectId: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('entityType') entityType?: EntityType,
  ) {
    return this.activityService.getProjectFeed(projectId, {
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
      entityType,
    });
  }
}
