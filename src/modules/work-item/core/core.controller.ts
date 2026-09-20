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
  BadRequestException,
  Req,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
} from '@nestjs/swagger';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Observable, fromEvent, merge } from 'rxjs';
import { map, filter, takeUntil } from 'rxjs/operators';
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
import { JwtAuthGuard } from '@/modules/identity/auth';
import { CurrentUser } from '@/modules/identity/auth';
import { ProjectRoleGuard, ProjectRoles } from '@/modules/project/access';

@ApiTags('Planning Work Items')
@ApiBearerAuth('JWT-auth')
@Controller(['api/v1', 'api'])
@UseGuards(JwtAuthGuard)
export class CoreController {
  constructor(
    private readonly workItemService: CoreService,
    @Optional() private readonly eventEmitter?: EventEmitter2,
  ) {}

  @Sse('projects/:projectId/work-items/events')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({
    summary: 'Stream realtime events for work items in a project',
  })
  streamWorkItemEvents(
    @Param('projectId') projectId: string,
    @Req() req: FastifyRequest,
  ): Observable<MessageEvent> {
    if (!this.eventEmitter) {
      return new Observable<MessageEvent>();
    }

    const disconnect$ = fromEvent(req.raw, 'close');

    const created$ = fromEvent(this.eventEmitter, 'work-item.created');
    const updated$ = fromEvent(this.eventEmitter, 'work-item.updated');
    const deleted$ = fromEvent(this.eventEmitter, 'work-item.deleted');
    const reordered$ = fromEvent(this.eventEmitter, 'work-item.reordered');
    const assigned$ = fromEvent(this.eventEmitter, 'work-item.assigned');
    const unassigned$ = fromEvent(this.eventEmitter, 'work-item.unassigned');
    const relationAdded$ = fromEvent(
      this.eventEmitter,
      'work-item.relation.added',
    );
    const relationRemoved$ = fromEvent(
      this.eventEmitter,
      'work-item.relation.removed',
    );
    const stateChanged$ = fromEvent(
      this.eventEmitter,
      'work-item.state.changed',
    );
    const priorityChanged$ = fromEvent(
      this.eventEmitter,
      'work-item.priority.changed',
    );
    const titleChanged$ = fromEvent(
      this.eventEmitter,
      'work-item.title.changed',
    );
    const contentChanged$ = fromEvent(
      this.eventEmitter,
      'work-item.content.changed',
    );
    const cycleChanged$ = fromEvent(
      this.eventEmitter,
      'work-item.cycle.changed',
    );
    const duplicated$ = fromEvent(this.eventEmitter, 'work-item.duplicated');
    const archived$ = fromEvent(this.eventEmitter, 'work-item.archived');
    const restored$ = fromEvent(this.eventEmitter, 'work-item.restored');

    return merge(
      created$,
      updated$,
      deleted$,
      reordered$,
      assigned$,
      unassigned$,
      relationAdded$,
      relationRemoved$,
      stateChanged$,
      priorityChanged$,
      titleChanged$,
      contentChanged$,
      cycleChanged$,
      duplicated$,
      archived$,
      restored$,
    ).pipe(
      filter((event: any) => event?.projectId === projectId),
      map((event: any) => ({
        data: event,
      })),
      takeUntil(disconnect$),
    );
  }

  @Get('work-items')
  @ApiOperation({
    summary:
      'Get current user work items across projects with optional filters',
  })
  async getUserWorkItems(
    @CurrentUser('id') userId: string,
    @Query() queryWorkItemDto: QueryWorkItemDto,
  ) {
    return this.workItemService.getUserWorkItems(userId, queryWorkItemDto);
  }

  @Get('projects/:projectId/work-items')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({
    summary: 'Get all work items in a project with optional filters',
  })
  async getProjectWorkItems(
    @Param('projectId') projectId: string,
    @Query() queryWorkItemDto: QueryWorkItemDto,
  ) {
    return this.workItemService.getProjectWorkItems(
      projectId,
      queryWorkItemDto,
    );
  }

  @Get(['work-items/:workItemId', 'projects/:projectId/work-items/:workItemId'])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Get a single work item by ID or identifier' })
  async getWorkItemById(@Param('workItemId') workItemId: string) {
    return this.workItemService.getWorkItemById(workItemId);
  }

  @Post('projects/:projectId/work-items')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Create a new work item in a project' })
  async createWorkItem(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
    @Body() createWorkItemDto: CreateWorkItemDto,
  ) {
    return this.workItemService.createWorkItem(
      projectId,
      userId,
      createWorkItemDto,
    );
  }

  @Put(['work-items/:workItemId', 'projects/:projectId/work-items/:workItemId'])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Update a work item' })
  async updateWorkItem(
    @Param('workItemId') workItemId: string,
    @CurrentUser('id') userId: string,
    @Body() updateWorkItemDto: UpdateWorkItemDto,
  ) {
    return this.workItemService.updateWorkItem(
      workItemId,
      updateWorkItemDto,
      userId,
    );
  }

  @Delete([
    'work-items/:workItemId',
    'projects/:projectId/work-items/:workItemId',
  ])
  @HttpCode(HttpStatus.OK)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Delete a work item' })
  async deleteWorkItem(
    @Param('workItemId') workItemId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.workItemService.deleteWorkItem(workItemId, userId);
  }

  @Put([
    'work-items/:workItemId/assign',
    'projects/:projectId/work-items/:workItemId/assign',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Assign a work item to a user (or unassign)' })
  async assignWorkItem(
    @Param('workItemId') workItemId: string,
    @CurrentUser('id') userId: string,
    @Body() assignWorkItemDto: AssignWorkItemDto,
  ) {
    return this.workItemService.updateWorkItem(
      workItemId,
      { assigneeId: assignWorkItemDto.assigneeId ?? null },
      userId,
    );
  }

  @Post(['work-items/:workItemId/children', 'work-items/:workItemId/sub-items'])
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({
    summary: 'Create a child work item under a parent work item',
  })
  async createChildWorkItem(
    @Param('workItemId') workItemId: string,
    @CurrentUser('id') userId: string,
    @Body() createWorkItemDto: CreateWorkItemDto,
  ) {
    return this.workItemService.createChildWorkItem(
      workItemId,
      userId,
      createWorkItemDto,
    );
  }

  @Put([
    'projects/:projectId/work-items/reorder',
    'work-items/reorder',
    'work-items/:workItemId/reorder',
  ])
  @HttpCode(HttpStatus.OK)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Reorder a work item in Kanban or List view' })
  async reorderWorkItem(
    @Body('workItemId') workItemIdFromBody: string | undefined,
    @Param('workItemId') workItemIdFromParam: string | undefined,
    @Body() reorderWorkItemDto: ReorderWorkItemDto,
  ) {
    const targetWorkItemId =
      workItemIdFromBody ||
      workItemIdFromParam ||
      reorderWorkItemDto?.workItemId ||
      '';
    return this.workItemService.reorderWorkItem(
      targetWorkItemId,
      reorderWorkItemDto,
    );
  }

  @Put(['projects/:projectId/work-items/bulk', 'work-items/bulk'])
  @HttpCode(HttpStatus.OK)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor')
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
  @ProjectRoles('owner', 'coordinator', 'contributor')
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

  @Post('work-items/:workItemId/duplicate')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Duplicate a work item' })
  async duplicateWorkItem(
    @Param('workItemId') workItemId: string,
    @CurrentUser('id') userId: string,
    @Body() duplicateWorkItemDto: DuplicateWorkItemDto,
  ) {
    const targetProjectId =
      duplicateWorkItemDto?.destinationProjectId ||
      (duplicateWorkItemDto as any)?.projectId;
    return this.workItemService.duplicateWorkItem(
      workItemId,
      userId,
      targetProjectId,
    );
  }

  @Post('work-items/:workItemId/convert-to-root')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Convert a child work item to a root work item' })
  async convertToRootWorkItem(@Param('workItemId') workItemId: string) {
    return this.workItemService.convertToRootWorkItem(workItemId);
  }
}

export const WorkItemController = CoreController;
export type WorkItemController = CoreController;
