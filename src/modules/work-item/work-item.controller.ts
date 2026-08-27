import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiQuery,
} from '@nestjs/swagger';
import { WorkItemService } from './work-item.service';
import {
  CreateWorkItemDto,
  UpdateWorkItemDto,
  AssignWorkItemDto,
  ReorderWorkItemDto,
  BulkUpdateWorkItemDto,
  QueryWorkItemDto,
} from './dto/work-item.dto';
import { JwtAuthGuard } from '@/modules/iam/authn/guards/jwt-auth.guard';
import { CurrentUser } from '@/modules/iam/authn/decorators/current-user.decorator';
import { WorkspaceRoleGuard } from '@/modules/iam/authz/guards/workspace-role.guard';
import { WorkspaceRoles } from '@/modules/iam/authz/decorators/workspace-roles.decorator';
import { ProjectRoleGuard } from '@/modules/iam/authz/guards/project-role.guard';
import { ProjectRoles } from '@/modules/iam/authz/decorators/project-roles.decorator';
import { ActivityService } from '@/modules/activity/activity.service';

@ApiTags('Planning Tasks & Work Items')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(JwtAuthGuard)
export class WorkItemController {
  constructor(
    private readonly workItemService: WorkItemService,
    private readonly activityService: ActivityService,
  ) {}

  @Get(['workspaces/:workspaceId/work-items', 'workspace/:workspaceId/tasks'])
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  @ApiOperation({
    summary: 'Get all work items across projects in a workspace',
  })
  @ApiResponse({ status: 200, description: 'List of work items in workspace' })
  async getWorkspaceTasks(@Param('workspaceId') workspaceId: string) {
    return this.workItemService.getWorkspaceTasks(workspaceId);
  }

  @Get([
    'projects/:projectId/work-items',
    'project/:projectId/tasks',
    'projects/:projectId/tasks',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor', 'commenter', 'viewer')
  @ApiOperation({
    summary:
      'Get all work items for a project with optional filters and pagination',
  })
  @ApiResponse({
    status: 200,
    description: 'Project work items with relations and column status',
  })
  async getTasks(
    @Param('projectId') projectId: string,
    @Query() query?: QueryWorkItemDto,
  ) {
    return this.workItemService.getProjectTasks(projectId, query);
  }

  @Post([
    'projects/:projectId/work-items',
    'project/:projectId/tasks',
    'projects/:projectId/tasks',
  ])
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor')
  @ApiOperation({ summary: 'Create a new work item in a project' })
  @ApiResponse({ status: 201, description: 'Created work item object' })
  async createTask(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CreateWorkItemDto,
  ) {
    return this.workItemService.createTask(projectId, userId, dto);
  }

  @Put([
    'projects/:projectId/work-items/reorder',
    'project/:projectId/tasks/reorder',
    'work-items/:taskId/reorder',
    'tasks/:taskId/reorder',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor')
  @ApiOperation({ summary: 'Reorder work items inside or across columns' })
  @ApiResponse({ status: 200, description: 'Reorder status' })
  async reorderTask(
    @Param('taskId') taskIdParam: string | undefined,
    @Body() dto: ReorderWorkItemDto,
  ) {
    const taskId = taskIdParam || dto.taskId || '';
    return this.workItemService.reorderTask(taskId, dto);
  }

  @Put([
    'projects/:projectId/work-items/bulk',
    'project/:projectId/tasks/bulk',
    'work-items/bulk',
    'tasks/bulk',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor')
  @ApiOperation({ summary: 'Bulk update multiple work items in a project' })
  @ApiResponse({
    status: 200,
    description: 'Bulk update status with affected count',
  })
  async bulkUpdateTasks(
    @Param('projectId') paramProjectId: string | undefined,
    @Body() dto: BulkUpdateWorkItemDto,
    @CurrentUser('id') userId: string,
  ) {
    const projectId = paramProjectId || '';
    return this.workItemService.bulkUpdate(projectId, dto, userId);
  }

  @Get([
    'work-items/:taskId',
    'tasks/:taskId',
    'projects/:projectId/work-items/:taskId',
    'project/:projectId/tasks/:taskId',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor', 'commenter', 'viewer')
  @ApiOperation({ summary: 'Get details of a single work item' })
  @ApiResponse({ status: 200, description: 'Work item details' })
  async getTask(@Param('taskId') taskId: string) {
    return this.workItemService.getTask(taskId);
  }

  @Put([
    'work-items/:taskId',
    'tasks/:taskId',
    'projects/:projectId/work-items/:taskId',
    'project/:projectId/tasks/:taskId',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor')
  @ApiOperation({ summary: 'Update a work item' })
  @ApiResponse({ status: 200, description: 'Updated work item object' })
  async updateTask(
    @Param('taskId') taskId: string,
    @Body() dto: UpdateWorkItemDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.workItemService.updateTask(taskId, dto, userId);
  }

  @Delete([
    'work-items/:taskId',
    'tasks/:taskId',
    'projects/:projectId/work-items/:taskId',
    'project/:projectId/tasks/:taskId',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor')
  @ApiOperation({ summary: 'Soft-delete a work item' })
  @ApiResponse({ status: 200, description: 'Deletion confirmation' })
  async deleteTask(
    @Param('taskId') taskId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.workItemService.deleteTask(taskId, userId);
  }

  @Post([
    'work-items/:taskId/restore',
    'tasks/:taskId/restore',
    'projects/:projectId/work-items/:taskId/restore',
    'project/:projectId/tasks/:taskId/restore',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor')
  @ApiOperation({ summary: 'Restore a soft-deleted work item' })
  @ApiResponse({ status: 200, description: 'Work item restored' })
  async restoreTask(
    @Param('taskId') taskId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.workItemService.restoreTask(taskId, userId);
  }

  @Put([
    'work-items/:taskId/assign',
    'tasks/:taskId/assign',
    'projects/:projectId/work-items/:taskId/assign',
    'project/:projectId/tasks/:taskId/assign',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor')
  @ApiOperation({ summary: 'Assign a user to a work item' })
  @ApiResponse({
    status: 200,
    description: 'Updated work item with new assignee',
  })
  async assignTask(
    @Param('taskId') taskId: string,
    @Body() dto: AssignWorkItemDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.workItemService.assignTask(taskId, dto.assignee, userId);
  }

  @Get(['work-items/:taskId/activity', 'tasks/:taskId/activity'])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor', 'commenter', 'viewer')
  @ApiOperation({ summary: 'Get work item audit and activity log stream' })
  @ApiResponse({ status: 200, description: 'List of work item activities' })
  async getAuditLog(@Param('taskId') taskId: string) {
    return this.activityService.getTaskActivity(taskId);
  }

  @Post(['work-items/:taskId/subtasks', 'tasks/:taskId/subtasks'])
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor')
  @ApiOperation({ summary: 'Create a subtask under a parent work item' })
  async createSubtask(
    @Param('taskId') taskId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CreateWorkItemDto,
  ) {
    dto.parentTaskId = taskId;
    const parent = await this.workItemService.getTask(taskId);
    const projectId = parent.task?.projectId;
    return this.workItemService.createTask(projectId, userId, dto);
  }

  @Post([
    'work-items/:taskId/duplicate',
    'tasks/:taskId/duplicate',
    'projects/:projectId/work-items/:taskId/duplicate',
    'project/:projectId/tasks/:taskId/duplicate',
  ])
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor')
  @ApiOperation({ summary: 'Duplicate an existing work item' })
  async duplicateTask(
    @Param('taskId') taskId: string,
    @CurrentUser('id') userId: string,
    @Body() body?: { projectId?: string },
  ) {
    return this.workItemService.duplicateTask(taskId, userId, body?.projectId);
  }

  @Post([
    'work-items/:taskId/attachments',
    'tasks/:taskId/attachments',
    'projects/:projectId/work-items/:taskId/attachments',
    'project/:projectId/tasks/:taskId/attachments',
  ])
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor')
  @ApiOperation({ summary: 'Attach a file or metadata to a work item' })
  async addAttachment(
    @Param('taskId') taskId: string,
    @CurrentUser('id') userId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.workItemService.addAttachment(taskId, body, userId);
  }

  @Delete([
    'work-items/:taskId/attachments/:attachmentId',
    'tasks/:taskId/attachments/:attachmentId',
    'projects/:projectId/work-items/:taskId/attachments/:attachmentId',
    'project/:projectId/tasks/:taskId/attachments/:attachmentId',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor')
  @ApiOperation({ summary: 'Delete an attachment from a work item' })
  async deleteAttachment(
    @Param('taskId') taskId: string,
    @Param('attachmentId') attachmentId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.workItemService.deleteAttachment(taskId, attachmentId, userId);
  }
}

// Backward compatibility alias
export const TaskController = WorkItemController;
export type TaskController = WorkItemController;
