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
@Controller('api')
@UseGuards(JwtAuthGuard)
export class HistoryController {
  constructor(private readonly historyService: HistoryService) {}

  @Get('work-items/:taskId/feed')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'contributor', 'commenter', 'viewer')
  @ApiOperation({
    summary:
      'Get unified collaboration feed for work item (Plane.so 5-tabs: all, activity, comments, transition, history)',
  })
  @ApiParam({ name: 'taskId', description: 'Work item ID' })
  async getWorkItemFeed(
    @Param('taskId') taskId: string,
    @Query() feedQueryDto: FeedQueryDto,
  ) {
    return this.historyService.getUnifiedFeed(taskId, feedQueryDto);
  }

  @Get('work-items/:taskId/transitions')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'contributor', 'commenter', 'viewer')
  @ApiOperation({
    summary:
      'Get state transitions and time-in-state calculation (Plane.so Transition tab)',
  })
  @ApiParam({ name: 'taskId', description: 'Work item ID' })
  async getTransitions(@Param('taskId') taskId: string) {
    return this.historyService.getTransitions(taskId);
  }

  @Get('work-items/:taskId/history')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'contributor', 'commenter', 'viewer')
  @ApiOperation({
    summary:
      'Get property changelog history with diff summary (Plane.so History tab)',
  })
  @ApiParam({ name: 'taskId', description: 'Work item ID' })
  async getHistory(
    @Param('taskId') taskId: string,
    @Query('sort') sort?: 'asc' | 'desc',
  ) {
    return this.historyService.getHistory(taskId, sort);
  }

  @Get('work-items/:taskId/activity')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'contributor', 'commenter', 'viewer')
  @ApiOperation({
    summary: 'Get activity events for work item (Plane.so Activity tab)',
  })
  @ApiParam({ name: 'taskId', description: 'Work item ID' })
  async getActivity(
    @Param('taskId') taskId: string,
    @Query('sort') sort?: 'asc' | 'desc',
  ) {
    return this.historyService.getActivity(taskId, sort);
  }
}
