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
import { AssignTaskDto, BulkAssignTaskDto, SetAssigneesDto, AddAssigneeDto } from './dto/assignment.dto';
import { JwtAuthGuard } from '@/modules/iam/authn/guards/jwt-auth.guard';
import { CurrentUser } from '@/modules/iam/authn/decorators/current-user.decorator';
import { ProjectRoleGuard } from '@/modules/iam/authz/guards/project-role.guard';
import { ProjectRoles } from '@/modules/iam/authz/decorators/project-roles.decorator';

@ApiTags('Work Item Assignments')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(JwtAuthGuard)
export class AssignmentController {
  constructor(private readonly assignmentService: AssignmentService) {}

  @Get([
    'projects/:projectId/work-items/assignees',
    'project/:projectId/work-items/assignees',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor', 'commenter', 'viewer')
  @ApiOperation({
    summary: 'Get eligible assignees for work items in a project',
  })
  @ApiResponse({
    status: 200,
    description:
      'List of active project members with admin or contributor roles',
  })
  async getEligibleAssignees(@Param('projectId') projectId: string) {
    return this.assignmentService.getEligibleAssignees(projectId);
  }

  @Post([
    'projects/:projectId/work-items/:taskId/assign',
    'project/:projectId/work-items/:taskId/assign',
  ])
  @HttpCode(HttpStatus.OK)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor')
  @ApiOperation({
    summary: 'Assign or unassign a work item to an eligible project member',
  })
  @ApiResponse({
    status: 200,
    description: 'Task assignment updated successfully',
  })
  async assignTask(
    @Param('projectId') projectId: string,
    @Param('taskId') taskId: string,
    @CurrentUser('id') userId: string,
    @Body() assignTaskDto: AssignTaskDto,
  ) {
    const targetAssignee =
      assignTaskDto.assigneeId !== undefined ? assignTaskDto.assigneeId : assignTaskDto.assignee;
    return this.assignmentService.assignTask(
      projectId,
      taskId,
      targetAssignee,
      userId,
    );
  }

  @Post([
    'projects/:projectId/work-items/:taskId/unassign',
    'project/:projectId/work-items/:taskId/unassign',
  ])
  @HttpCode(HttpStatus.OK)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor')
  @ApiOperation({
    summary: 'Unassign a work item',
  })
  @ApiResponse({ status: 200, description: 'Task unassigned successfully' })
  async unassignTask(
    @Param('projectId') projectId: string,
    @Param('taskId') taskId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.assignmentService.unassignTask(projectId, taskId, userId);
  }

  @Post([
    'projects/:projectId/work-items/:taskId/join',
    'project/:projectId/work-items/:taskId/join',
  ])
  @HttpCode(HttpStatus.OK)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor')
  @ApiOperation({
    summary: 'Join a work item (self-assign by current user)',
  })
  @ApiResponse({ status: 200, description: 'Task assigned to caller' })
  async joinTask(
    @Param('projectId') projectId: string,
    @Param('taskId') taskId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.assignmentService.joinTask(projectId, taskId, userId);
  }

  @Post([
    'projects/:projectId/work-items/:taskId/leave',
    'project/:projectId/work-items/:taskId/leave',
  ])
  @HttpCode(HttpStatus.OK)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor')
  @ApiOperation({
    summary: 'Leave a work item (remove self-assignment)',
  })
  @ApiResponse({ status: 200, description: 'Task unassigned from caller' })
  async leaveTask(
    @Param('projectId') projectId: string,
    @Param('taskId') taskId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.assignmentService.leaveTask(projectId, taskId, userId);
  }

  @Post([
    'projects/:projectId/work-items/bulk-assign',
    'project/:projectId/work-items/bulk-assign',
  ])
  @HttpCode(HttpStatus.OK)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor')
  @ApiOperation({
    summary: 'Bulk assign multiple work items to a member',
  })
  @ApiResponse({ status: 200, description: 'Tasks updated count' })
  async bulkAssign(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
    @Body() bulkAssignTaskDto: BulkAssignTaskDto,
  ) {
    return this.assignmentService.bulkAssign(projectId, bulkAssignTaskDto, userId);
  }

  // ── MULTI-ASSIGNEE ENDPOINTS ────────────────────────────────────────────────

  @Get([
    'projects/:projectId/work-items/:taskId/assignees',
    'project/:projectId/work-items/:taskId/assignees',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor', 'commenter', 'viewer')
  @ApiOperation({ summary: 'Get all assignees (primary + co-assignees) of a work item' })
  @ApiResponse({ status: 200, description: 'Ordered list of assignee user objects' })
  async getAssignees(
    @Param('projectId') projectId: string,
    @Param('taskId') taskId: string,
  ) {
    return this.assignmentService.getAssignees(projectId, taskId);
  }

  @Put([
    'projects/:projectId/work-items/:taskId/assignees',
    'project/:projectId/work-items/:taskId/assignees',
  ])
  @HttpCode(HttpStatus.OK)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor')
  @ApiOperation({
    summary:
      'Replace the full assignee list of a work item. First entry becomes primary assignee.',
  })
  @ApiResponse({ status: 200, description: 'Updated assignee list and primary assignee ID' })
  async setAssignees(
    @Param('projectId') projectId: string,
    @Param('taskId') taskId: string,
    @CurrentUser('id') userId: string,
    @Body() setAssigneesDto: SetAssigneesDto,
  ) {
    return this.assignmentService.setAssignees(projectId, taskId, setAssigneesDto, userId);
  }

  @Post([
    'projects/:projectId/work-items/:taskId/assignees',
    'project/:projectId/work-items/:taskId/assignees',
  ])
  @HttpCode(HttpStatus.OK)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor')
  @ApiOperation({ summary: 'Add a single co-assignee to a work item (idempotent)' })
  @ApiResponse({ status: 200, description: 'Updated assignee list' })
  async addAssignee(
    @Param('projectId') projectId: string,
    @Param('taskId') taskId: string,
    @CurrentUser('id') userId: string,
    @Body() addAssigneeDto: AddAssigneeDto,
  ) {
    return this.assignmentService.addAssignee(projectId, taskId, addAssigneeDto, userId);
  }

  @Delete([
    'projects/:projectId/work-items/:taskId/assignees/:targetUserId',
    'project/:projectId/work-items/:taskId/assignees/:targetUserId',
  ])
  @HttpCode(HttpStatus.OK)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor')
  @ApiOperation({ summary: 'Remove a co-assignee from a work item' })
  @ApiResponse({ status: 200, description: 'Updated assignee list after removal' })
  async removeAssignee(
    @Param('projectId') projectId: string,
    @Param('taskId') taskId: string,
    @Param('targetUserId') targetUserId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.assignmentService.removeAssignee(projectId, taskId, targetUserId, userId);
  }
}
