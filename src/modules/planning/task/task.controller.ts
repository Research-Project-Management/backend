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
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { TaskService } from './task.service';
import {
  CreateTaskDto,
  UpdateTaskDto,
  AssignTaskDto,
  ReorderTaskDto,
  BulkUpdateTaskDto,
} from './dto/task.dto';
import { JwtAuthGuard } from '@/core/guards/jwt-auth.guard';
import { CurrentUser } from '@/core/decorators/current-user.decorator';

@ApiTags('Planning')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(JwtAuthGuard)
export class TaskController {
  constructor(private readonly taskService: TaskService) {}

  @Get('workspace/:workspaceId/tasks')
  async getWorkspaceTasks(@Param('workspaceId') workspaceId: string) {
    return this.taskService.getWorkspaceTasks(workspaceId);
  }

  @Get('project/:projectId/tasks')
  async getTasks(@Param('projectId') projectId: string) {
    return this.taskService.getTasks(projectId);
  }

  @Post('project/:projectId/tasks')
  @HttpCode(HttpStatus.CREATED)
  async createTask(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CreateTaskDto,
  ) {
    return this.taskService.createTask(projectId, userId, dto);
  }

  @Put('project/:projectId/tasks/reorder/batch')
  async reorderTask(
    @Param('projectId') projectId: string,
    @Body() dto: ReorderTaskDto,
  ) {
    return this.taskService.reorderTasks(projectId, dto);
  }

  @Put('project/:projectId/tasks/bulk')
  async bulkUpdateTasks(
    @Param('projectId') projectId: string,
    @Body() dto: BulkUpdateTaskDto,
  ) {
    return this.taskService.bulkUpdateTasks(projectId, dto);
  }

  @Get(['project/:projectId/tasks/:taskId', 'tasks/:taskId'])
  async getTask(@Param('taskId') taskId: string) {
    return this.taskService.getTask(taskId);
  }

  @Put(['project/:projectId/tasks/:taskId', 'tasks/:taskId'])
  async updateTask(
    @Param('taskId') taskId: string,
    @Body() dto: UpdateTaskDto,
  ) {
    return this.taskService.updateTask(taskId, dto);
  }

  @Delete(['project/:projectId/tasks/:taskId', 'tasks/:taskId'])
  async deleteTask(@Param('taskId') taskId: string) {
    return this.taskService.deleteTask(taskId);
  }

  @Put('project/:projectId/tasks/:taskId/assign')
  async assignTask(
    @Param('taskId') taskId: string,
    @Body() dto: AssignTaskDto,
  ) {
    return this.taskService.assignTask(taskId, dto.assignee);
  }

  @Post([
    'project/:projectId/tasks/:taskId/duplicate',
    'tasks/:taskId/duplicate',
  ])
  @HttpCode(HttpStatus.CREATED)
  async duplicateTask(
    @Param('taskId') taskId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.taskService.duplicateTask(taskId, userId);
  }

  @Get('tasks/:taskId/activity')
  async getAuditLog(@Param('taskId') taskId: string) {
    return this.taskService.getAuditLog(taskId);
  }
}
