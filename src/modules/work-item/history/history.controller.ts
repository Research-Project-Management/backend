import {
  Controller,
  Get,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '@/modules/iam/authn/guards/jwt-auth.guard';
import { ProjectRoleGuard } from '@/modules/iam/authz/guards/project-role.guard';
import { ProjectRoles } from '@/modules/iam/authz/decorators/project-roles.decorator';
import { HistoryService } from './history.service';
import { FeedQueryDto } from './dto/feed-query.dto';

@ApiTags('Work Item History & Activity')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(JwtAuthGuard)
export class HistoryController {
  constructor(private readonly historyService: HistoryService) {}

  @Get([
    'work-items/:taskId/feed',
    'tasks/:taskId/feed',
    'projects/:projectId/work-items/:taskId/feed',
    'project/:projectId/work-items/:taskId/feed',
    'projects/:projectId/tasks/:taskId/feed',
    'project/:projectId/tasks/:taskId/feed',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor', 'commenter', 'viewer')
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

  @Get([
    'work-items/:taskId/transitions',
    'tasks/:taskId/transitions',
    'projects/:projectId/work-items/:taskId/transitions',
    'project/:projectId/work-items/:taskId/transitions',
    'projects/:projectId/tasks/:taskId/transitions',
    'project/:projectId/tasks/:taskId/transitions',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor', 'commenter', 'viewer')
  @ApiOperation({
    summary:
      'Get state transitions and time-in-state calculation (Plane.so Transition tab)',
  })
  @ApiParam({ name: 'taskId', description: 'Work item ID' })
  async getTransitions(@Param('taskId') taskId: string) {
    return this.historyService.getTransitions(taskId);
  }

  @Get([
    'work-items/:taskId/history',
    'tasks/:taskId/history',
    'projects/:projectId/work-items/:taskId/history',
    'project/:projectId/work-items/:taskId/history',
    'projects/:projectId/tasks/:taskId/history',
    'project/:projectId/tasks/:taskId/history',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor', 'commenter', 'viewer')
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

  @Get([
    'work-items/:taskId/activity',
    'tasks/:taskId/activity',
    'projects/:projectId/work-items/:taskId/activity',
    'project/:projectId/work-items/:taskId/activity',
    'projects/:projectId/tasks/:taskId/activity',
    'project/:projectId/tasks/:taskId/activity',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor', 'commenter', 'viewer')
  @ApiOperation({
    summary:
      'Get activity events for work item (Plane.so Activity tab)',
  })
  @ApiParam({ name: 'taskId', description: 'Work item ID' })
  async getActivity(
    @Param('taskId') taskId: string,
    @Query('sort') sort?: 'asc' | 'desc',
  ) {
    return this.historyService.getActivity(taskId, sort);
  }
}
