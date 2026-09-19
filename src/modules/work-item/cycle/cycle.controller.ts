import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Body,
  Param,
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
import { CycleService } from './cycle.service';
import {
  CreateCycleDto,
  UpdateCycleDto,
  AddCycleWorkItemDto,
  AddCycleWorkItemsBatchDto,
  CompleteCycleDto,
} from './dto/cycle.dto';
import { JwtAuthGuard } from '@/modules/iam/authn/guards/auth.guard';
import { CurrentUser } from '@/modules/iam/authn/decorators/user.decorator';
import { ProjectRoleGuard } from '@/modules/iam/authz/guards/role.guard';
import { ProjectRoles } from '@/modules/iam/authz/decorators/role.decorator';

@ApiTags('Planning Cycles')
@ApiBearerAuth('JWT-auth')
@Controller(['api/v1', 'api'])
@UseGuards(JwtAuthGuard)
export class CycleController {
  constructor(private readonly cycleService: CycleService) {}

  @Get(['projects/:projectId/cycles', 'project/:projectId/cycles'])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Get all cycles for a project' })
  @ApiResponse({
    status: 200,
    description: 'List of project cycles with WorkItem summaries',
  })
  async getCycles(@Param('projectId') projectId: string) {
    return this.cycleService.getCycles(projectId);
  }

  @Post(['projects/:projectId/cycles', 'project/:projectId/cycles'])
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Create a new cycle in a project' })
  @ApiResponse({ status: 201, description: 'Created cycle object' })
  async createCycle(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
    @Body() createCycleDto: CreateCycleDto,
  ) {
    return this.cycleService.createCycle(projectId, userId, createCycleDto);
  }

  @Get(['projects/:projectId/cycles/:cycleId', 'cycles/:cycleId'])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Get a cycle by ID with progress stats' })
  @ApiResponse({ status: 200, description: 'Detailed cycle object' })
  async getCycleById(@Param('cycleId') cycleId: string) {
    return this.cycleService.getCycle(cycleId);
  }

  @Get([
    'projects/:projectId/cycles/:cycleId/progress',
    'cycles/:cycleId/progress',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Get progress statistics for a cycle' })
  @ApiResponse({ status: 200, description: 'Progress statistics object' })
  async getProgress(@Param('cycleId') cycleId: string) {
    return this.cycleService.getCycleProgress(cycleId);
  }

  @Patch(['projects/:projectId/cycles/:cycleId', 'cycles/:cycleId'])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Update a cycle partially' })
  @ApiResponse({ status: 200, description: 'Updated cycle object' })
  async updateCycle(
    @Param('cycleId') cycleId: string,
    @Body() updateCycleDto: UpdateCycleDto,
  ) {
    return this.cycleService.updateCycle(cycleId, updateCycleDto);
  }

  @Put(['projects/:projectId/cycles/:cycleId', 'cycles/:cycleId'])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Update a cycle completely' })
  @ApiResponse({ status: 200, description: 'Updated cycle object' })
  async replaceCycle(
    @Param('cycleId') cycleId: string,
    @Body() updateCycleDto: UpdateCycleDto,
  ) {
    return this.cycleService.updateCycle(cycleId, updateCycleDto);
  }

  @Delete(['projects/:projectId/cycles/:cycleId', 'cycles/:cycleId'])
  @HttpCode(HttpStatus.OK)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Soft-delete a cycle' })
  @ApiResponse({ status: 200, description: 'Cycle deleted confirmation' })
  async deleteCycle(@Param('cycleId') cycleId: string) {
    return this.cycleService.deleteCycle(cycleId);
  }

  @Post([
    'projects/:projectId/cycles/:cycleId/restore',
    'cycles/:cycleId/restore',
  ])
  @HttpCode(HttpStatus.OK)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Restore a soft-deleted cycle' })
  @ApiResponse({ status: 200, description: 'Cycle restored' })
  async restoreCycle(@Param('cycleId') cycleId: string) {
    return this.cycleService.restoreCycle(cycleId);
  }

  @Post([
    'projects/:projectId/cycles/:cycleId/work-items',
    'cycles/:cycleId/work-items',
  ])
  @HttpCode(HttpStatus.OK)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Add a work item to a cycle' })
  @ApiResponse({ status: 200, description: 'Updated cycle object' })
  async addWorkItem(
    @Param('cycleId') cycleId: string,
    @Body() addCycleWorkItemDto: AddCycleWorkItemDto,
  ) {
    return this.cycleService.addWorkItem(
      cycleId,
      addCycleWorkItemDto.workItemId,
    );
  }

  @Post([
    'projects/:projectId/cycles/:cycleId/work-items/batch',
    'cycles/:cycleId/work-items/batch',
  ])
  @HttpCode(HttpStatus.OK)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Add multiple work items to a cycle in batch' })
  @ApiResponse({ status: 200, description: 'Batch addition summary' })
  async addWorkItemsBatch(
    @Param('cycleId') cycleId: string,
    @Body() addCycleWorkItemsBatchDto: AddCycleWorkItemsBatchDto,
  ) {
    return this.cycleService.addWorkItemsBatch(
      cycleId,
      addCycleWorkItemsBatchDto.workItemIds,
    );
  }

  @Delete([
    'projects/:projectId/cycles/:cycleId/work-items/:workItemId',
    'cycles/:cycleId/work-items/:workItemId',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Remove a work item from a cycle' })
  @ApiResponse({ status: 200, description: 'WorkItem removal confirmation' })
  async removeWorkItem(
    @Param('cycleId') cycleId: string,
    @Param('workItemId') workItemId: string,
  ) {
    return this.cycleService.removeWorkItem(cycleId, workItemId);
  }

  @Post([
    'projects/:projectId/cycles/:cycleId/complete',
    'cycles/:cycleId/complete',
  ])
  @HttpCode(HttpStatus.OK)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Complete a cycle and roll incomplete work items' })
  @ApiResponse({
    status: 200,
    description: 'Completed cycle with rollover summary',
  })
  async completeCycle(
    @Param('cycleId') cycleId: string,
    @Body() completeCycleDto: CompleteCycleDto,
  ) {
    return this.cycleService.completeCycle(cycleId, completeCycleDto);
  }

  @Post('projects/:projectId/cycles/auto-transition')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({
    summary:
      'Auto-start upcoming cycle and complete expired active cycle for a project',
  })
  @ApiResponse({ status: 200, description: 'Auto-transition result' })
  async autoTransitionCycles(@Param('projectId') projectId: string) {
    return this.cycleService.processAutoTransitions(projectId);
  }

  @Get([
    'projects/:projectId/cycles/:cycleId/burndown',
    'cycles/:cycleId/burndown',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({
    summary:
      'Get burndown chart time-series data for a cycle (ideal vs actual points remaining)',
  })
  @ApiResponse({ status: 200, description: 'Cycle burndown series' })
  async getBurndown(@Param('cycleId') cycleId: string) {
    return this.cycleService.getCycleBurndown(cycleId);
  }

  @Get([
    'projects/:projectId/cycles/:cycleId/velocity',
    'cycles/:cycleId/velocity',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({
    summary:
      'Get velocity metric for a completed cycle (committed vs completed work items and points)',
  })
  @ApiResponse({ status: 200, description: 'Cycle velocity metric' })
  async getVelocity(@Param('cycleId') cycleId: string) {
    return this.cycleService.getCycleVelocity(cycleId);
  }
}
