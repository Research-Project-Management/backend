import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '@/modules/iam/authn/guards/auth.guard';
import { ProjectRoleGuard } from '@/modules/iam/authz/guards/role.guard';
import { ProjectRoles } from '@/modules/iam/authz/decorators/role.decorator';
import { HistoryService } from './history.service';
import { FeedQueryDto } from './dto/feed-query.dto';

@ApiTags('Work Item History & Activity')
@ApiBearerAuth('JWT-auth')
@Controller(['api/v1', 'api'])
@UseGuards(JwtAuthGuard)
export class HistoryController {
  constructor(private readonly historyService: HistoryService) {}

  @Get('work-items/:workItemId/feed')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'contributor', 'commenter', 'viewer')
  @ApiOperation({
    summary:
      'Get unified collaboration feed for work item (Plane.so 5-tabs: all, activity, comments, transition, history)',
  })
  @ApiParam({ name: 'workItemId', description: 'Work item ID' })
  async getWorkItemFeed(
    @Param('workItemId') workItemId: string,
    @Query() feedQueryDto: FeedQueryDto,
  ) {
    return this.historyService.getUnifiedFeed(workItemId, feedQueryDto);
  }

  @Get('work-items/:workItemId/transitions')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'contributor', 'commenter', 'viewer')
  @ApiOperation({
    summary:
      'Get state transitions and time-in-state calculation (Plane.so Transition tab)',
  })
  @ApiParam({ name: 'workItemId', description: 'Work item ID' })
  async getTransitions(@Param('workItemId') workItemId: string) {
    return this.historyService.getTransitions(workItemId);
  }

  @Get('work-items/:workItemId/history')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'contributor', 'commenter', 'viewer')
  @ApiOperation({
    summary:
      'Get property changelog history with diff summary (Plane.so History tab)',
  })
  @ApiParam({ name: 'workItemId', description: 'Work item ID' })
  async getHistory(
    @Param('workItemId') workItemId: string,
    @Query('sort') sort?: 'asc' | 'desc',
  ) {
    return this.historyService.getHistory(workItemId, sort);
  }

  @Get('work-items/:workItemId/activity')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'contributor', 'commenter', 'viewer')
  @ApiOperation({
    summary: 'Get activity events for work item (Plane.so Activity tab)',
  })
  @ApiParam({ name: 'workItemId', description: 'Work item ID' })
  async getActivity(
    @Param('workItemId') workItemId: string,
    @Query('sort') sort?: 'asc' | 'desc',
  ) {
    return this.historyService.getActivity(workItemId, sort);
  }
}
