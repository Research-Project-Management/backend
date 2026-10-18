import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '@/modules/identity/auth';
import { HistoryService } from './history.service';
import { ProjectAccessGuard, ProjectRoles } from '@/modules/project/access';

@ApiTags('Work Item History & Activity')
@ApiBearerAuth('JWT-auth')
@Controller(['api/v1', 'api'])
@UseGuards(JwtAuthGuard)
export class HistoryController {
  constructor(private readonly historyService: HistoryService) {}

  @Get('work-items/:workItemId/activity')
  @UseGuards(ProjectAccessGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
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
