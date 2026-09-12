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
  Sse,
  MessageEvent,
  Optional,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
} from '@nestjs/swagger';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Observable, fromEvent, merge } from 'rxjs';
import { map, filter } from 'rxjs/operators';
import { CoreService } from './core.service';
import { CreateWorkItemDto } from './dto/create.dto';
import { UpdateWorkItemDto } from './dto/update.dto';
import { QueryWorkItemDto } from './dto/query.dto';
import {
  AssignWorkItemDto,
  ReorderWorkItemDto,
  BulkUpdateWorkItemDto,
  BulkDeleteWorkItemDto,
  DuplicateWorkItemDto,
} from './dto/bulk.dto';
import { JwtAuthGuard } from '@/modules/iam/authn/guards/auth.guard';
import { CurrentUser } from '@/modules/iam/authn/decorators/user.decorator';
import { ProjectRoleGuard } from '@/modules/iam/authz/guards/role.guard';
import { ProjectRoles } from '@/modules/iam/authz/decorators/role.decorator';

@ApiTags('Planning Tasks & Work Items')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(JwtAuthGuard)
export class CoreController {
  constructor(
    private readonly workItemService: CoreService,
    @Optional() private readonly eventEmitter?: EventEmitter2,
  ) {}

  @Sse('projects/:projectId/work-items/events')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'contributor', 'commenter', 'viewer')
  @ApiOperation({
    summary: 'Stream realtime events for work items in a project',
  })
  streamWorkItemEvents(
    @Param('projectId') projectId: string,
  ): Observable<MessageEvent> {
    if (!this.eventEmitter) {
      return new Observable<MessageEvent>();
    }

    const created$ = fromEvent(this.eventEmitter, 'task.created');
    const updated$ = fromEvent(this.eventEmitter, 'task.updated');
    const deleted$ = fromEvent(this.eventEmitter, 'task.deleted');
    const reordered$ = fromEvent(this.eventEmitter, 'task.reordered');

    return merge(created$, updated$, deleted$, reordered$).pipe(
      filter((event: any) => event?.projectId === projectId),
      map(
        (event: any) =>
          ({
            data: event,
          }) as MessageEvent,
      ),
    );
  }

  @Get('projects/:projectId/work-items')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'contributor', 'commenter', 'viewer')
  @ApiOperation({
    summary: 'Get all work items in a project with optional filters',
  })
  async getProjectTasks(
    @Param('projectId') projectId: string,
    @Query() queryWorkItemDto: QueryWorkItemDto,
  ) {
    return this.workItemService.getProjectTasks(projectId, queryWorkItemDto);
  }

  @Get(['work-items/:taskId', 'projects/:projectId/work-items/:taskId'])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'contributor', 'commenter', 'viewer')
  @ApiOperation({ summary: 'Get a single work item by ID or identifier' })
  async getTaskById(@Param('taskId') taskId: string) {
    return this.workItemService.getTaskById(taskId);
  }

  @Post('projects/:projectId/work-items')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'contributor')
  @ApiOperation({ summary: 'Create a new work item in a project' })
  async createTask(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
    @Body() createWorkItemDto: CreateWorkItemDto,
  ) {
    return this.workItemService.createTask(
      projectId,
      userId,
      createWorkItemDto,
    );
  }

  @Put('work-items/:taskId')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'contributor')
  @ApiOperation({ summary: 'Update a work item' })
  async updateTask(
    @Param('taskId') taskId: string,
    @CurrentUser('id') userId: string,
    @Body() updateWorkItemDto: UpdateWorkItemDto,
  ) {
    return this.workItemService.updateTask(taskId, updateWorkItemDto, userId);
  }

  @Delete('work-items/:taskId')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'contributor')
  @ApiOperation({ summary: 'Delete a work item' })
  async deleteTask(
    @Param('taskId') taskId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.workItemService.deleteTask(taskId, userId);
  }

  @Put('work-items/:taskId/assign')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'contributor')
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

  @Post('work-items/:taskId/subtasks')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'contributor')
  @ApiOperation({ summary: 'Create a subtask under a parent work item' })
  async createSubtask(
    @Param('taskId') taskId: string,
    @CurrentUser('id') userId: string,
    @Body() createWorkItemDto: CreateWorkItemDto,
  ) {
    return this.workItemService.createSubtask(
      taskId,
      userId,
      createWorkItemDto,
    );
  }

  @Put([
    'projects/:projectId/work-items/reorder',
    'work-items/reorder',
    'work-items/:taskId/reorder',
  ])
  @HttpCode(HttpStatus.OK)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'contributor')
  @ApiOperation({ summary: 'Reorder a work item in Kanban or List view' })
  async reorderTask(
    @Body('workItemId') workItemIdFromBody: string | undefined,
    @Body('taskId') taskIdFromBody: string | undefined,
    @Param('taskId') taskIdFromParam: string | undefined,
    @Body() reorderWorkItemDto: ReorderWorkItemDto,
  ) {
    const targetTaskId =
      workItemIdFromBody ||
      taskIdFromBody ||
      taskIdFromParam ||
      reorderWorkItemDto?.workItemId ||
      reorderWorkItemDto?.taskId ||
      '';
    return this.workItemService.reorderTask(targetTaskId, reorderWorkItemDto);
  }

  @Put([
    'projects/:projectId/work-items/bulk',
    'work-items/bulk',
  ])
  @HttpCode(HttpStatus.OK)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'contributor')
  @ApiOperation({ summary: 'Bulk update multiple work items' })
  async bulkUpdate(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
    @Body() bulkUpdateWorkItemDto: BulkUpdateWorkItemDto,
  ) {
    const effectiveProjectId =
      projectId || bulkUpdateWorkItemDto.projectId || '';
    return this.workItemService.bulkUpdate(
      effectiveProjectId,
      bulkUpdateWorkItemDto,
      userId,
    );
  }

  @Post([
    'projects/:projectId/work-items/bulk-delete',
    'work-items/bulk-delete',
  ])
  @HttpCode(HttpStatus.OK)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'contributor')
  @ApiOperation({ summary: 'Bulk delete multiple work items' })
  async bulkDelete(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
    @Body() bulkDeleteWorkItemDto: BulkDeleteWorkItemDto,
  ) {
    const effectiveProjectId =
      projectId || bulkDeleteWorkItemDto.projectId || '';
    return this.workItemService.bulkDelete(
      effectiveProjectId,
      bulkDeleteWorkItemDto,
      userId,
    );
  }

  @Post('work-items/:taskId/duplicate')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'contributor')
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

  @Post('work-items/:taskId/convert-to-root')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'contributor')
  @ApiOperation({ summary: 'Convert a subtask to a root work item' })
  async convertToRootTask(@Param('taskId') taskId: string) {
    return this.workItemService.convertToRootTask(taskId);
  }
}

export const WorkItemController = CoreController;
export type WorkItemController = CoreController;
export const TaskController = CoreController;
export type TaskController = CoreController;
