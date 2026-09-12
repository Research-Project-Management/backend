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
} from '@nestjs/swagger';
import { WorkItemService } from './work-item.service';
import { CreateWorkItemDto } from './dto/create-work-item.dto';
import { UpdateWorkItemDto } from './dto/update-work-item.dto';
import { QueryWorkItemDto } from './dto/query-work-item.dto';
import {
  AssignWorkItemDto,
  ReorderWorkItemDto,
  BulkUpdateWorkItemDto,
  BulkDeleteWorkItemDto,
  DuplicateWorkItemDto,
} from './dto/bulk-work-item.dto';
import { JwtAuthGuard } from '@/modules/iam/authn/guards/jwt-auth.guard';
import { CurrentUser } from '@/modules/iam/authn/decorators/current-user.decorator';
import { WorkspaceRoleGuard } from '@/modules/iam/authz/guards/workspace-role.guard';
import { WorkspaceRoles } from '@/modules/iam/authz/decorators/workspace-roles.decorator';
import { ProjectRoleGuard } from '@/modules/iam/authz/guards/project-role.guard';
import { ProjectRoles } from '@/modules/iam/authz/decorators/project-roles.decorator';

@ApiTags('Planning Tasks & Work Items')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(JwtAuthGuard)
export class WorkItemController {
  constructor(private readonly workItemService: WorkItemService) {}

  @Get(['workspaces/:workspaceId/work-items', 'workspaces/:workspaceId/tasks'])
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  @ApiOperation({ summary: 'Get all work items in a workspace' })
  async getWorkspaceTasks(@Param('workspaceId') workspaceId: string) {
    return this.workItemService.getWorkspaceTasks(workspaceId);
  }

  @Get([
    'projects/:projectId/work-items',
    'project/:projectId/work-items',
    'projects/:projectId/tasks',
    'project/:projectId/tasks',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor', 'commenter', 'viewer')
  @ApiOperation({ summary: 'Get all work items in a project with optional filters' })
  async getProjectTasks(
    @Param('projectId') projectId: string,
    @Query() queryWorkItemDto: QueryWorkItemDto,
  ) {
    return this.workItemService.getProjectTasks(projectId, queryWorkItemDto);
  }

  @Get([
    'projects/:projectId/work-items/:taskId',
    'project/:projectId/work-items/:taskId',
    'work-items/:taskId',
    'tasks/:taskId',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor', 'commenter', 'viewer')
  @ApiOperation({ summary: 'Get a single work item by ID or identifier' })
  async getTaskById(@Param('taskId') taskId: string) {
    return this.workItemService.getTaskById(taskId);
  }

  @Post([
    'projects/:projectId/work-items',
    'project/:projectId/work-items',
    'projects/:projectId/tasks',
    'project/:projectId/tasks',
  ])
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor')
  @ApiOperation({ summary: 'Create a new work item in a project' })
  async createTask(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
    @Body() createWorkItemDto: CreateWorkItemDto,
  ) {
    return this.workItemService.createTask(projectId, userId, createWorkItemDto);
  }

  @Put([
    'projects/:projectId/work-items/:taskId',
    'project/:projectId/work-items/:taskId',
    'work-items/:taskId',
    'tasks/:taskId',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor')
  @ApiOperation({ summary: 'Update a work item' })
  async updateTask(
    @Param('taskId') taskId: string,
    @CurrentUser('id') userId: string,
    @Body() updateWorkItemDto: UpdateWorkItemDto,
  ) {
    return this.workItemService.updateTask(taskId, updateWorkItemDto, userId);
  }

  @Delete([
    'projects/:projectId/work-items/:taskId',
    'project/:projectId/work-items/:taskId',
    'work-items/:taskId',
    'tasks/:taskId',
  ])
  @HttpCode(HttpStatus.OK)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor')
  @ApiOperation({ summary: 'Delete a work item' })
  async deleteTask(
    @Param('taskId') taskId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.workItemService.deleteTask(taskId, userId);
  }

  @Put([
    'projects/:projectId/work-items/:taskId/assign',
    'project/:projectId/work-items/:taskId/assign',
    'work-items/:taskId/assign',
    'tasks/:taskId/assign',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor')
  @ApiOperation({ summary: 'Assign a work item to a user (or unassign)' })
  async assignTask(
    @Param('taskId') taskId: string,
    @CurrentUser('id') userId: string,
    @Body() assignWorkItemDto: AssignWorkItemDto,
  ) {
    return this.workItemService.updateTask(
      taskId,
      { assigneeId: assignWorkItemDto.assigneeId ?? null },
      userId,
    );
  }

  @Post([
    'projects/:projectId/work-items/:taskId/subtasks',
    'project/:projectId/work-items/:taskId/subtasks',
    'work-items/:taskId/subtasks',
    'tasks/:taskId/subtasks',
  ])
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor')
  @ApiOperation({ summary: 'Create a subtask under a parent work item' })
  async createSubtask(
    @Param('taskId') taskId: string,
    @CurrentUser('id') userId: string,
    @Body() createWorkItemDto: CreateWorkItemDto,
  ) {
    return this.workItemService.createSubtask(taskId, userId, createWorkItemDto);
  }

  @Post([
    'projects/:projectId/work-items/reorder',
    'project/:projectId/work-items/reorder',
    'work-items/reorder',
    'tasks/reorder',
  ])
  @Put([
    'projects/:projectId/work-items/reorder',
    'project/:projectId/work-items/reorder',
    'work-items/:taskId/reorder',
    'tasks/:taskId/reorder',
  ])
  @HttpCode(HttpStatus.OK)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor')
  @ApiOperation({ summary: 'Reorder a work item in Kanban or List view' })
  async reorderTask(
    @Body('taskId') taskIdFromBody: string,
    @Param('taskId') taskIdFromParam: string | undefined,
    @Body() reorderWorkItemDto: ReorderWorkItemDto,
  ) {
    const targetTaskId = taskIdFromBody || taskIdFromParam || '';
    return this.workItemService.reorderTask(targetTaskId, reorderWorkItemDto);
  }

  @Post([
    'projects/:projectId/work-items/bulk-update',
    'project/:projectId/work-items/bulk-update',
    'work-items/bulk-update',
    'tasks/bulk-update',
  ])
  @Put([
    'projects/:projectId/work-items/bulk',
    'project/:projectId/work-items/bulk',
    'work-items/bulk',
    'tasks/bulk',
  ])
  @HttpCode(HttpStatus.OK)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor')
  @ApiOperation({ summary: 'Bulk update multiple work items' })
  async bulkUpdate(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
    @Body() bulkUpdateWorkItemDto: BulkUpdateWorkItemDto,
  ) {
    const effectiveProjectId = projectId || bulkUpdateWorkItemDto.projectId || '';
    return this.workItemService.bulkUpdate(effectiveProjectId, bulkUpdateWorkItemDto, userId);
  }

  @Post([
    'projects/:projectId/work-items/bulk-delete',
    'project/:projectId/work-items/bulk-delete',
    'work-items/bulk-delete',
    'tasks/bulk-delete',
  ])
  @HttpCode(HttpStatus.OK)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor')
  @ApiOperation({ summary: 'Bulk delete multiple work items' })
  async bulkDelete(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
    @Body() bulkDeleteWorkItemDto: BulkDeleteWorkItemDto,
  ) {
    const effectiveProjectId = projectId || bulkDeleteWorkItemDto.projectId || '';
    return this.workItemService.bulkDelete(effectiveProjectId, bulkDeleteWorkItemDto, userId);
  }

  @Post([
    'projects/:projectId/work-items/:taskId/duplicate',
    'project/:projectId/work-items/:taskId/duplicate',
    'work-items/:taskId/duplicate',
    'tasks/:taskId/duplicate',
  ])
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor')
  @ApiOperation({ summary: 'Duplicate a work item' })
  async duplicateTask(
    @Param('taskId') taskId: string,
    @CurrentUser('id') userId: string,
    @Body() duplicateWorkItemDto: DuplicateWorkItemDto,
  ) {
    return this.workItemService.duplicateTask(
      taskId,
      userId,
      duplicateWorkItemDto?.destinationProjectId,
    );
  }

  @Post([
    'projects/:projectId/work-items/:taskId/convert-to-root',
    'project/:projectId/work-items/:taskId/convert-to-root',
    'work-items/:taskId/convert-to-root',
    'tasks/:taskId/convert-to-root',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor')
  @ApiOperation({ summary: 'Convert a subtask to a root work item' })
  async convertToRootTask(@Param('taskId') taskId: string) {
    return this.workItemService.convertToRootTask(taskId);
  }
}
