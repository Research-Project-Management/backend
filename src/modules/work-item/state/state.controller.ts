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
import { StateService } from './state.service';
import {
  CreateStateDto,
  UpdateStateDto,
  ReorderStatesDto,
} from './dto/state.dto';
import { JwtAuthGuard } from '@/modules/iam/authn/guards/jwt-auth.guard';
import { CurrentUser } from '@/modules/iam/authn/decorators/current-user.decorator';
import { ProjectRoleGuard } from '@/modules/iam/authz/guards/project-role.guard';
import { ProjectRoles } from '@/modules/iam/authz/decorators/project-roles.decorator';

@ApiTags('Work Item States')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(JwtAuthGuard)
export class StateController {
  constructor(private readonly stateService: StateService) {}

  @Get([
    'projects/:projectId/states',
    'project/:projectId/states',
    'projects/:projectId/columns',
    'project/:projectId/columns',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor', 'commenter', 'viewer')
  @ApiOperation({
    summary: 'List all project work item states with lifecycle groups',
  })
  @ApiResponse({
    status: 200,
    description: 'List of states grouped by sequence and lifecycle group',
  })
  async getStates(@Param('projectId') projectId: string) {
    return this.stateService.getStates(projectId);
  }

  @Get([
    'projects/:projectId/states/counts',
    'project/:projectId/states/counts',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor', 'commenter', 'viewer')
  @ApiOperation({
    summary: 'Get active work item counts by state in a project',
  })
  @ApiResponse({
    status: 200,
    description: 'Map of stateId to task count',
  })
  async getStateTaskCounts(@Param('projectId') projectId: string) {
    return this.stateService.getStateTaskCounts(projectId);
  }

  @Get([
    'projects/:projectId/states/:stateId',
    'project/:projectId/states/:stateId',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor', 'commenter', 'viewer')
  @ApiOperation({ summary: 'Get details of a specific state' })
  @ApiResponse({ status: 200, description: 'State details' })
  async getStateById(
    @Param('projectId') projectId: string,
    @Param('stateId') stateId: string,
  ) {
    return this.stateService.getStateById(projectId, stateId);
  }

  @Post([
    'projects/:projectId/states',
    'project/:projectId/states',
    'projects/:projectId/columns',
    'project/:projectId/columns',
  ])
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin')
  @ApiOperation({
    summary: 'Create a new work item state with group categorization (Admin only)',
  })
  @ApiResponse({ status: 201, description: 'Created state object' })
  async createState(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
    @Body() createStateDto: CreateStateDto,
  ) {
    return this.stateService.createState(projectId, createStateDto, userId);
  }

  @Put([
    'projects/:projectId/states/reorder',
    'project/:projectId/states/reorder',
    'projects/:projectId/columns/reorder',
    'project/:projectId/columns/reorder',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin')
  @ApiOperation({
    summary: 'Reorder states sequence and optionally update groups (Admin only)',
  })
  @ApiResponse({ status: 200, description: 'Updated list of states' })
  async reorderStates(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
    @Body() reorderStatesDto: ReorderStatesDto,
  ) {
    return this.stateService.reorderStates(projectId, reorderStatesDto, userId);
  }

  @Post([
    'projects/:projectId/states/reset',
    'project/:projectId/states/reset',
    'projects/:projectId/columns/reset',
    'project/:projectId/columns/reset',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin')
  @ApiOperation({
    summary: 'Reset project states to the 5 default preset states (Admin only)',
  })
  @ApiResponse({ status: 200, description: 'Standard preset states' })
  async resetStates(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.stateService.resetToDefaultStates(projectId, userId);
  }

  @Put([
    'projects/:projectId/states/:stateId',
    'project/:projectId/states/:stateId',
    'projects/:projectId/columns/:stateId',
    'project/:projectId/columns/:stateId',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin')
  @ApiOperation({ summary: 'Update state name, color, group, or default flag (Admin only)' })
  @ApiResponse({ status: 200, description: 'Updated state object' })
  async updateState(
    @Param('projectId') projectId: string,
    @Param('stateId') stateId: string,
    @CurrentUser('id') userId: string,
    @Body() updateStateDto: UpdateStateDto,
  ) {
    return this.stateService.updateState(projectId, stateId, updateStateDto, userId);
  }

  @Delete([
    'projects/:projectId/states/:stateId',
    'project/:projectId/states/:stateId',
    'projects/:projectId/columns/:stateId',
    'project/:projectId/columns/:stateId',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin')
  @ApiOperation({
    summary: 'Delete a state with safe task migration rules',
  })
  @ApiQuery({
    name: 'targetStateId',
    required: false,
    description: 'Target state ID to migrate active work items to',
  })
  @ApiQuery({
    name: 'targetColumnId',
    required: false,
    description: 'Backwards-compatibility alias for targetStateId',
  })
  @ApiResponse({
    status: 200,
    description: 'Updated states after deletion and migration',
  })
  async deleteState(
    @Param('projectId') projectId: string,
    @Param('stateId') stateId: string,
    @Query('targetStateId') targetStateId?: string,
    @Query('targetColumnId') targetColumnId?: string,
    @CurrentUser('id') userId?: string,
  ) {
    const fallbackId = targetStateId || targetColumnId;
    return this.stateService.deleteState(
      projectId,
      stateId,
      fallbackId,
      userId,
    );
  }
}
