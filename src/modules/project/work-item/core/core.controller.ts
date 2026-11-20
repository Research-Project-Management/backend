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
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { CoreService } from './core.service';
import {
  CreateWorkItemDto,
  UpdateWorkItemDto,
  QueryWorkItemDto,
  ReorderWorkItemDto,
  BulkUpdateWorkItemDto,
  BulkDeleteWorkItemDto,
  DuplicateWorkItemDto,
} from './dto/core.dto';
import { JwtAuthGuard } from '@/modules/identity/auth';
import { CurrentUser } from '@/modules/identity/auth';
import { ProjectAccessGuard, ProjectRoles } from '@/modules/project/access';

@ApiTags('Planning Work Items')
@ApiBearerAuth('JWT-auth')
@Controller(['api/v1', 'api'])
@UseGuards(JwtAuthGuard)
export class CoreController {
  constructor(private readonly coreService: CoreService) {}

  @Get('work-items')
  @ApiOperation({
    summary:
      'Get current user work items across projects with optional filters',
  })
  async getUserWorkItems(
    @CurrentUser('id') userId: string,
    @Query() queryWorkItemDto: QueryWorkItemDto,
  ) {
    return this.coreService.getUserWorkItems(userId, queryWorkItemDto);
  }

  @Get('projects/:projectId/work-items')
  @UseGuards(ProjectAccessGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({
    summary: 'Get all work items in a project with optional filters',
  })
  async getProjectWorkItems(
    @Param('projectId') projectId: string,
    @Query() queryWorkItemDto: QueryWorkItemDto,
  ) {
    return this.coreService.getProjectWorkItems(projectId, queryWorkItemDto);
  }

  @Get('projects/:projectId/work-items/analytics')
  @UseGuards(ProjectAccessGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({
    summary: 'Get project work item analytics and dimensional breakdowns',
  })
  async getProjectWorkItemAnalytics(@Param('projectId') projectId: string) {
    return this.coreService.getWorkItemAnalytics(projectId);
  }

  @Get(['work-items/:workItemId', 'projects/:projectId/work-items/:workItemId'])
  @UseGuards(ProjectAccessGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Get a single work item by ID or identifier' })
  async getWorkItemById(@Param('workItemId') workItemId: string) {
    return this.coreService.getWorkItemById(workItemId);
  }

  @Post('projects/:projectId/work-items')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(ProjectAccessGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Create a new work item in a project' })
  async createWorkItem(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
    @Body() createWorkItemDto: CreateWorkItemDto,
  ) {
    return this.coreService.createWorkItem(
      projectId,
      userId,
      createWorkItemDto,
    );
  }

  @Put(['work-items/:workItemId', 'projects/:projectId/work-items/:workItemId'])
  @UseGuards(ProjectAccessGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Update a work item' })
  async updateWorkItem(
    @Param('workItemId') workItemId: string,
    @CurrentUser('id') userId: string,
    @Body() updateWorkItemDto: UpdateWorkItemDto,
  ) {
    return this.coreService.updateWorkItem(
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
  @UseGuards(ProjectAccessGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Delete a work item' })
  async deleteWorkItem(
    @Param('workItemId') workItemId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.coreService.deleteWorkItem(workItemId, userId);
  }

  @Post(['work-items/:workItemId/children', 'work-items/:workItemId/sub-items'])
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(ProjectAccessGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({
    summary: 'Create a child work item under a parent work item',
  })
  async createChildWorkItem(
    @Param('workItemId') workItemId: string,
    @CurrentUser('id') userId: string,
    @Body() createWorkItemDto: CreateWorkItemDto,
  ) {
    return this.coreService.createChildWorkItem(
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
  @UseGuards(ProjectAccessGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Reorder a work item in Kanban or List view' })
  async reorderWorkItem(
    @Body('workItemId') workItemIdFromBody: string | undefined,
    @Param('workItemId') workItemIdFromParam: string | undefined,
    @Body() reorderWorkItemDto: ReorderWorkItemDto,
    @CurrentUser('id') userId?: string,
  ) {
    const targetWorkItemId =
      workItemIdFromBody ||
      workItemIdFromParam ||
      reorderWorkItemDto?.workItemId ||
      '';
    return this.coreService.reorderWorkItem(
      targetWorkItemId,
      reorderWorkItemDto,
      userId,
    );
  }

  @Put(['projects/:projectId/work-items/bulk', 'work-items/bulk'])
  @HttpCode(HttpStatus.OK)
  @UseGuards(ProjectAccessGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Bulk update multiple work items' })
  async bulkUpdate(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
    @Body() bulkUpdateWorkItemDto: BulkUpdateWorkItemDto,
  ) {
    const effectiveProjectId =
      projectId || bulkUpdateWorkItemDto.projectId || '';
    return this.coreService.bulkUpdate(
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
  @UseGuards(ProjectAccessGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Bulk delete multiple work items' })
  async bulkDelete(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
    @Body() bulkDeleteWorkItemDto: BulkDeleteWorkItemDto,
  ) {
    const effectiveProjectId =
      projectId || bulkDeleteWorkItemDto.projectId || '';
    return this.coreService.bulkDelete(
      effectiveProjectId,
      bulkDeleteWorkItemDto,
      userId,
    );
  }

  @Post('work-items/:workItemId/duplicate')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(ProjectAccessGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Duplicate a work item' })
  async duplicateWorkItem(
    @Param('workItemId') workItemId: string,
    @CurrentUser('id') userId: string,
    @Body() duplicateWorkItemDto: DuplicateWorkItemDto,
  ) {
    const targetProjectId =
      duplicateWorkItemDto?.destinationProjectId ||
      duplicateWorkItemDto?.projectId;
    return this.coreService.duplicateWorkItem(
      workItemId,
      userId,
      targetProjectId,
    );
  }

  @Post('work-items/:workItemId/convert-to-root')
  @UseGuards(ProjectAccessGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Convert a child work item to a root work item' })
  async convertToRootWorkItem(@Param('workItemId') workItemId: string) {
    return this.coreService.convertToRootWorkItem(workItemId);
  }
}
