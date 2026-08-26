import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { ActivityService } from './activity.service';
import { JwtAuthGuard } from '@/modules/iam/authn/guards/jwt-auth.guard';
import { CurrentUser } from '@/modules/iam/authn/decorators/current-user.decorator';
import { WorkspaceRoleGuard } from '@/modules/iam/authz/guards/workspace-role.guard';
import { ProjectRoleGuard } from '@/modules/iam/authz/guards/project-role.guard';
import { WorkspaceRoles } from '@/modules/iam/authz/decorators/workspace-roles.decorator';
import { ProjectRoles } from '@/modules/iam/authz/decorators/project-roles.decorator';
import { EntityType } from '@prisma/client';

@ApiTags('Activity')
@ApiBearerAuth('JWT-auth')
@Controller('api/activity')
@UseGuards(JwtAuthGuard)
export class ActivityController {
  constructor(private readonly activityService: ActivityService) {}

  @Get('workspaces/:workspaceId/feed')
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
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
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
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
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor', 'commenter', 'viewer')
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
