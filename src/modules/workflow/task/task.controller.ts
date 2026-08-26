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
import { TaskService } from './task.service';
import {
  CreateTaskDto,
  UpdateTaskDto,
  AssignTaskDto,
  ReorderTaskDto,
  BulkUpdateTaskDto,
} from './dto/task.dto';
import { JwtAuthGuard } from '@/modules/iam/authn/guards/jwt-auth.guard';
import { CurrentUser } from '@/modules/iam/authn/decorators/current-user.decorator';
import { WorkspaceRoleGuard } from '@/modules/iam/authz/guards/workspace-role.guard';
import { WorkspaceRoles } from '@/modules/iam/authz/decorators/workspace-roles.decorator';
import { ProjectRoleGuard } from '@/modules/iam/authz/guards/project-role.guard';
import { ProjectRoles } from '@/modules/iam/authz/decorators/project-roles.decorator';
import { ActivityService } from '@/modules/activity/activity.service';

@ApiTags('Planning Tasks')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(JwtAuthGuard)
export class TaskController {
  constructor(
    private readonly taskService: TaskService,
    private readonly activityService: ActivityService,
  ) {}

  @Get('workspace/:workspaceId/tasks')
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  @ApiOperation({ summary: 'Get all tasks across projects in a workspace' })
  @ApiResponse({ status: 200, description: 'List of tasks in workspace' })
  async getWorkspaceTasks(@Param('workspaceId') workspaceId: string) {
    return this.taskService.getWorkspaceTasks(workspaceId);
  }

  @Get('project/:projectId/tasks')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor', 'commenter', 'viewer')
  @ApiOperation({
    summary: 'Get all tasks for a specific project with optional cycle filter',
  })
  @ApiQuery({
    name: 'cycle',
    required: false,
    description: 'Optional cycle ID to filter tasks',
  })
  @ApiResponse({
    status: 200,
    description: 'Project tasks with column definitions and project info',
  })
  async getTasks(
    @Param('projectId') projectId: string,
    @Query('cycle') cycleId?: string,
  ) {
    return this.taskService.getProjectTasks(projectId, cycleId);
  }

  @Post('project/:projectId/tasks')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor')
  @ApiOperation({ summary: 'Create a new task in a project' })
  @ApiResponse({ status: 201, description: 'Created task object' })
  async createTask(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CreateTaskDto,
  ) {
    return this.taskService.createTask(projectId, userId, dto);
  }

  @Put(['project/:projectId/tasks/reorder', 'tasks/:taskId/reorder'])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor')
  @ApiOperation({ summary: 'Reorder tasks in/between columns' })
  @ApiResponse({ status: 200, description: 'Reorder status' })
  async reorderTask(
    @Param('taskId') taskIdParam: string | undefined,
    @Body() dto: ReorderTaskDto,
  ) {
    const taskId = taskIdParam || dto.taskId || '';
    return this.taskService.reorderTask(taskId, dto);
  }

  @Put(['project/:projectId/tasks/bulk', 'tasks/bulk'])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor')
  @ApiOperation({ summary: 'Bulk update multiple tasks in a project' })
  @ApiResponse({
    status: 200,
    description: 'Bulk update status with affected count',
  })
  async bulkUpdateTasks(
    @Param('projectId') paramProjectId: string | undefined,
    @Body() dto: BulkUpdateTaskDto,
    @CurrentUser('id') userId: string,
  ) {
    const projectId = paramProjectId || '';
    return this.taskService.bulkUpdate(projectId, dto, userId);
  }

  @Get(['tasks/:taskId', 'project/:projectId/tasks/:taskId'])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor', 'commenter', 'viewer')
  @ApiOperation({ summary: 'Get details of a single task' })
  @ApiResponse({ status: 200, description: 'Task detail' })
  async getTask(@Param('taskId') taskId: string) {
    return this.taskService.getTask(taskId);
  }

  @Put(['tasks/:taskId', 'project/:projectId/tasks/:taskId'])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor')
  @ApiOperation({ summary: 'Update a task' })
  @ApiResponse({ status: 200, description: 'Updated task object' })
  async updateTask(
    @Param('taskId') taskId: string,
    @Body() dto: UpdateTaskDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.taskService.updateTask(taskId, dto, userId);
  }

  @Delete(['tasks/:taskId', 'project/:projectId/tasks/:taskId'])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor')
  @ApiOperation({ summary: 'Soft-delete a task' })
  @ApiResponse({ status: 200, description: 'Task deletion confirmation' })
  async deleteTask(
    @Param('taskId') taskId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.taskService.deleteTask(taskId, userId);
  }

  @Post(['tasks/:taskId/restore', 'project/:projectId/tasks/:taskId/restore'])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor')
  @ApiOperation({ summary: 'Restore a soft-deleted task' })
  @ApiResponse({ status: 200, description: 'Task restored' })
  async restoreTask(@Param('taskId') taskId: string) {
    return this.taskService.restoreTask(taskId);
  }

  @Put(['tasks/:taskId/assign', 'project/:projectId/tasks/:taskId/assign'])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor')
  @ApiOperation({ summary: 'Assign a user to a task' })
  @ApiResponse({ status: 200, description: 'Updated task with new assignee' })
  async assignTask(
    @Param('taskId') taskId: string,
    @Body() dto: AssignTaskDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.taskService.assignTask(taskId, dto.assignee, userId);
  }

  @Get('tasks/:taskId/activity')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor', 'commenter', 'viewer')
  @ApiOperation({ summary: 'Get task audit and activity logs' })
  @ApiResponse({ status: 200, description: 'List of task activities' })
  async getAuditLog(@Param('taskId') taskId: string) {
    return this.activityService.getTaskActivity(taskId);
  }

  @Post('tasks/:taskId/subtasks')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor')
  @ApiOperation({ summary: 'Create a subtask under a parent task' })
  async createSubtask(
    @Param('taskId') taskId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CreateTaskDto,
  ) {
    dto.parentTaskId = taskId;
    const parent = await this.taskService.getTask(taskId);
    const projectId = parent.task?.projectId;
    return this.taskService.createTask(projectId, userId, dto);
  }

  @Post([
    'tasks/:taskId/duplicate',
    'project/:projectId/tasks/:taskId/duplicate',
  ])
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor')
  @ApiOperation({ summary: 'Duplicate an existing task' })
  async duplicateTask(
    @Param('taskId') taskId: string,
    @CurrentUser('id') userId: string,
    @Body() body?: { projectId?: string },
  ) {
    return this.taskService.duplicateTask(taskId, userId, body?.projectId);
  }

  @Post([
    'tasks/:taskId/attachments',
    'project/:projectId/tasks/:taskId/attachments',
  ])
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor')
  @ApiOperation({ summary: 'Attach a file or metadata to a task' })
  async addAttachment(
    @Param('taskId') taskId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.taskService.addAttachment(taskId, body);
  }

  @Delete([
    'tasks/:taskId/attachments/:attachmentId',
    'project/:projectId/tasks/:taskId/attachments/:attachmentId',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor')
  @ApiOperation({ summary: 'Delete an attachment from a task' })
  async deleteAttachment(
    @Param('taskId') taskId: string,
    @Param('attachmentId') attachmentId: string,
  ) {
    return this.taskService.deleteAttachment(taskId, attachmentId);
  }
}
