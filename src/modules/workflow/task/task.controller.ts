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
import { JwtAuthGuard, CurrentUser } from '@/modules/iam/authn';
import {
  WorkspaceRoleGuard,
  WorkspaceRoles,
  ProjectRoleGuard,
  ProjectRoles,
} from '@/modules/iam/authz';
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
    return this.taskService.getTasks(projectId, cycleId);
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

  @Put('project/:projectId/tasks/reorder/batch')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor')
  @ApiOperation({ summary: 'Reorder tasks in/between columns' })
  @ApiResponse({ status: 200, description: 'Reorder status' })
  async reorderTask(
    @Param('projectId') projectId: string,
    @Body() dto: ReorderTaskDto,
  ) {
    return this.taskService.reorderTasks(projectId, dto);
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
  ) {
    const projectId = paramProjectId || '';
    return this.taskService.bulkUpdateTasks(projectId, dto);
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
  ) {
    return this.taskService.updateTask(taskId, dto);
  }

  @Delete(['tasks/:taskId', 'project/:projectId/tasks/:taskId'])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor')
  @ApiOperation({ summary: 'Delete a task' })
  @ApiResponse({ status: 200, description: 'Task deletion confirmation' })
  async deleteTask(@Param('taskId') taskId: string) {
    return this.taskService.deleteTask(taskId);
  }

  @Put(['tasks/:taskId/assign', 'project/:projectId/tasks/:taskId/assign'])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor')
  @ApiOperation({ summary: 'Assign a user to a task' })
  @ApiResponse({ status: 200, description: 'Updated task with new assignee' })
  async assignTask(
    @Param('taskId') taskId: string,
    @Body() dto: AssignTaskDto,
  ) {
    return this.taskService.assignTask(taskId, dto.assignee);
  }

  @Post([
    'tasks/:taskId/duplicate',
    'project/:projectId/tasks/:taskId/duplicate',
  ])
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor')
  @ApiOperation({ summary: 'Duplicate an existing task' })
  @ApiResponse({ status: 201, description: 'New duplicated task object' })
  async duplicateTask(
    @Param('taskId') taskId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.taskService.duplicateTask(taskId, userId);
  }

  @Get('tasks/:taskId/activity')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor', 'commenter', 'viewer')
  @ApiOperation({ summary: 'Get task audit and activity logs' })
  @ApiResponse({ status: 200, description: 'List of task activities' })
  async getAuditLog(@Param('taskId') taskId: string) {
    return this.activityService.getTaskActivity(taskId);
  }
}
