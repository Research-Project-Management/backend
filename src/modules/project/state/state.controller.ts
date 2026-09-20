import {
  Controller,
  Get,
  Post,
  Patch,
  Put,
  Delete,
  Param,
  Body,
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
import { JwtAuthGuard, CurrentUser } from '@/modules/identity/auth';
import { StateService } from './state.service';
import { UpdateProjectStateDto } from './dto/update-project-state.dto';
import { ProjectCurrentStateResponseDto } from './dto/project-state-response.dto';
import {
  CreateProjectStateDto,
  UpdateProjectStateItemDto,
  ReorderProjectStatesDto,
} from './dto/project-state.dto';
import { ProjectRoleGuard, ProjectRoles } from '@/modules/project/access';

@ApiTags('Project States')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller(['api/v1/projects', 'api/projects'])
export class StateController {
  constructor(private readonly stateService: StateService) {}

  // ── System Defaults Template ─────────────────────────────────────────────────

  @Get(['settings/states/default-template', 'states/default-template'])
  @ApiOperation({
    summary: 'List default research project state templates',
  })
  getDefaultStatesTemplate() {
    return this.stateService.getDefaultStatesTemplate();
  }

  // ── Project Specific States (Customizable & Drag-and-Drop Reorderable) ──────

  @Get(':projectId/settings/states')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({
    summary: 'List all states configured for a project, sorted by sequence for drag & drop UI',
  })
  @ApiResponse({
    status: 200,
    description: 'Array of project states ordered by sequence ASC',
  })
  getProjectStates(@Param('projectId') projectId: string) {
    return this.stateService.getProjectStates(projectId);
  }

  @Post(':projectId/settings/states')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a new custom state for the project (Owner only)',
  })
  createProjectState(
    @Param('projectId') projectId: string,
    @Body() dto: CreateProjectStateDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.stateService.createCustomState(projectId, dto, actorId);
  }

  @Patch(':projectId/settings/states/:stateId')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner')
  @ApiOperation({
    summary: 'Update a project state name, color, description, or sequence (Owner only)',
  })
  updateProjectStateItem(
    @Param('projectId') projectId: string,
    @Param('stateId') stateId: string,
    @Body() dto: UpdateProjectStateItemDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.stateService.updateCustomState(projectId, stateId, dto, actorId);
  }

  @Put(':projectId/settings/states/reorder')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner')
  @ApiOperation({
    summary: 'Reorder project states sequence after drag & drop (Owner only)',
  })
  reorderProjectStates(
    @Param('projectId') projectId: string,
    @Body() dto: ReorderProjectStatesDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.stateService.reorderStates(projectId, dto, actorId);
  }

  @Delete(':projectId/settings/states/:stateId')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner')
  @ApiOperation({
    summary: 'Permanently delete a custom state with optional fallback state migration (Owner only)',
  })
  @ApiQuery({
    name: 'fallbackStateId',
    required: false,
    description: 'Target state ID to move project into if currently at state being deleted',
  })
  deleteProjectState(
    @Param('projectId') projectId: string,
    @Param('stateId') stateId: string,
    @Query('fallbackStateId') fallbackStateId?: string,
    @CurrentUser('id') actorId?: string,
  ) {
    return this.stateService.deleteCustomState(
      projectId,
      stateId,
      fallbackStateId,
      actorId,
    );
  }

  // ── Project State Status & Transitions ──────────────────────────────────────

  @Get([':projectId/settings/state', ':projectId/state'])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({
    summary: 'Get current state of a research project',
  })
  @ApiResponse({
    status: 200,
    description: 'Current project state details',
    type: ProjectCurrentStateResponseDto,
  })
  getProjectState(@Param('projectId') projectId: string) {
    return this.stateService.getProjectCurrentState(projectId);
  }

  @Patch([':projectId/settings/state', ':projectId/state'])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner')
  @ApiOperation({
    summary: 'Update research project state by stateId (Owner only)',
  })
  @ApiResponse({
    status: 200,
    description: 'Updated project state',
    type: ProjectCurrentStateResponseDto,
  })
  updateProjectState(
    @Param('projectId') projectId: string,
    @Body() dto: UpdateProjectStateDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.stateService.transitionToState(projectId, dto.stateId ?? null, actorId);
  }
}

