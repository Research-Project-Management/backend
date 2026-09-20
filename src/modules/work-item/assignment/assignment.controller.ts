import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
} from '@nestjs/swagger';
import { AssignmentService } from './assignment.service';
import {
  AssignWorkItemDto,
  BulkAssignWorkItemDto,
  SetAssigneesDto,
  AddAssigneeDto,
} from './dto/assignment.dto';
import { JwtAuthGuard } from '@/modules/identity/auth';
import { CurrentUser } from '@/modules/identity/auth';
import { ProjectRoleGuard, ProjectRoles } from '@/modules/project/access';

@ApiTags('Work Item Assignments')
@ApiBearerAuth('JWT-auth')
@Controller(['api/v1', 'api'])
@UseGuards(JwtAuthGuard)
export class AssignmentController {
  constructor(private readonly assignmentService: AssignmentService) {}

  @Get('projects/:projectId/work-items/assignees')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({
    summary: 'Get eligible assignees for work items in a project',
  })
  @ApiResponse({
    status: 200,
    description:
      'List of active project members with owner or contributor roles',
  })
  async getEligibleAssignees(@Param('projectId') projectId: string) {
    return this.assignmentService.getEligibleAssignees(projectId);
  }

  @Post('projects/:projectId/work-items/:workItemId/assign')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({
    summary: 'Assign or unassign a work item to an eligible project member',
  })
  @ApiResponse({
    status: 200,
    description: 'WorkItem assignment updated successfully',
  })
  async assignWorkItem(
    @Param('projectId') projectId: string,
    @Param('workItemId') workItemId: string,
    @CurrentUser('id') userId: string,
    @Body() assignWorkItemDto: AssignWorkItemDto,
  ) {
    return this.assignmentService.assignWorkItem(
      projectId,
      workItemId,
      assignWorkItemDto.assigneeId ?? null,
      userId,
    );
  }

  @Post('projects/:projectId/work-items/:workItemId/unassign')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({
    summary: 'Unassign a work item',
  })
  @ApiResponse({ status: 200, description: 'WorkItem unassigned successfully' })
  async unassignWorkItem(
    @Param('projectId') projectId: string,
    @Param('workItemId') workItemId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.assignmentService.unassignWorkItem(
      projectId,
      workItemId,
      userId,
    );
  }

  @Post('projects/:projectId/work-items/:workItemId/join')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({
    summary: 'Join a work item (self-assign by current user)',
  })
  @ApiResponse({ status: 200, description: 'WorkItem assigned to caller' })
  async joinWorkItem(
    @Param('projectId') projectId: string,
    @Param('workItemId') workItemId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.assignmentService.joinWorkItem(projectId, workItemId, userId);
  }

  @Post('projects/:projectId/work-items/:workItemId/leave')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({
    summary: 'Leave a work item (remove self-assignment)',
  })
  @ApiResponse({ status: 200, description: 'WorkItem unassigned from caller' })
  async leaveWorkItem(
    @Param('projectId') projectId: string,
    @Param('workItemId') workItemId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.assignmentService.leaveWorkItem(projectId, workItemId, userId);
  }

  @Post('projects/:projectId/work-items/bulk-assign')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({
    summary: 'Bulk assign multiple work items to a member',
  })
  @ApiResponse({ status: 200, description: 'Work items updated count' })
  async bulkAssign(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
    @Body() bulkAssignWorkItemDto: BulkAssignWorkItemDto,
  ) {
    return this.assignmentService.bulkAssign(
      projectId,
      bulkAssignWorkItemDto,
      userId,
    );
  }

  // ── MULTI-ASSIGNEE ENDPOINTS ────────────────────────────────────────────────

  @Get('projects/:projectId/work-items/:workItemId/assignees')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({
    summary: 'Get all assignees (primary + co-assignees) of a work item',
  })
  @ApiResponse({
    status: 200,
    description: 'Ordered list of assignee user objects',
  })
  async getAssignees(
    @Param('projectId') projectId: string,
    @Param('workItemId') workItemId: string,
  ) {
    return this.assignmentService.getAssignees(projectId, workItemId);
  }

  @Put('projects/:projectId/work-items/:workItemId/assignees')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({
    summary:
      'Replace the full assignee list of a work item. First entry becomes primary assignee.',
  })
  @ApiResponse({
    status: 200,
    description: 'Updated assignee list and primary assignee ID',
  })
  async setAssignees(
    @Param('projectId') projectId: string,
    @Param('workItemId') workItemId: string,
    @CurrentUser('id') userId: string,
    @Body() setAssigneesDto: SetAssigneesDto,
  ) {
    return this.assignmentService.setAssignees(
      projectId,
      workItemId,
      setAssigneesDto,
      userId,
    );
  }

  @Post('projects/:projectId/work-items/:workItemId/assignees')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({
    summary: 'Add a single co-assignee to a work item (idempotent)',
  })
  @ApiResponse({ status: 200, description: 'Updated assignee list' })
  async addAssignee(
    @Param('projectId') projectId: string,
    @Param('workItemId') workItemId: string,
    @CurrentUser('id') userId: string,
    @Body() addAssigneeDto: AddAssigneeDto,
  ) {
    return this.assignmentService.addAssignee(
      projectId,
      workItemId,
      addAssigneeDto,
      userId,
    );
  }

  @Delete('projects/:projectId/work-items/:workItemId/assignees/:targetUserId')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Remove a co-assignee from a work item' })
  @ApiResponse({
    status: 200,
    description: 'Updated assignee list after removal',
  })
  async removeAssignee(
    @Param('projectId') projectId: string,
    @Param('workItemId') workItemId: string,
    @Param('targetUserId') targetUserId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.assignmentService.removeAssignee(
      projectId,
      workItemId,
      targetUserId,
      userId,
    );
  }

  @Post('projects/:projectId/work-items/:workItemId/subscribers/me')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({
    summary: 'Subscribe current user to notifications for a work item',
  })
  @ApiResponse({
    status: 200,
    description: 'Updated subscriber list for the work item',
  })
  async subscribeMe(
    @Param('projectId') projectId: string,
    @Param('workItemId') workItemId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.assignmentService.subscribeMe(projectId, workItemId, userId);
  }

  @Delete('projects/:projectId/work-items/:workItemId/subscribers/me')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({
    summary: 'Unsubscribe current user from notifications for a work item',
  })
  @ApiResponse({
    status: 200,
    description: 'Updated subscriber list for the work item',
  })
  async unsubscribeMe(
    @Param('projectId') projectId: string,
    @Param('workItemId') workItemId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.assignmentService.unsubscribeMe(projectId, workItemId, userId);
  }
}
