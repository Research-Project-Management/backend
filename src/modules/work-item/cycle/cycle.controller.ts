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
  AddCycleTaskDto,
  AddCycleTasksBatchDto,
  CompleteCycleDto,
} from './dto/cycle.dto';
import { JwtAuthGuard } from '@/modules/iam/authn/guards/jwt-auth.guard';
import { CurrentUser } from '@/modules/iam/authn/decorators/current-user.decorator';
import { ProjectRoleGuard } from '@/modules/iam/authz/guards/project-role.guard';
import { ProjectRoles } from '@/modules/iam/authz/decorators/project-roles.decorator';

@ApiTags('Planning Cycles')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(JwtAuthGuard)
export class CycleController {
  constructor(private readonly cycleService: CycleService) {}

  @Get(['projects/:projectId/cycles', 'project/:projectId/cycles'])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor', 'commenter', 'viewer')
  @ApiOperation({ summary: 'Get all cycles for a project' })
  @ApiResponse({
    status: 200,
    description: 'List of project cycles with task summaries',
  })
  async getCycles(@Param('projectId') projectId: string) {
    return this.cycleService.getCycles(projectId);
  }

  @Post(['projects/:projectId/cycles', 'project/:projectId/cycles'])
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor')
  @ApiOperation({ summary: 'Create a new cycle in a project' })
  @ApiResponse({ status: 201, description: 'Created cycle object' })
  async createCycle(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
    @Body() createCycleDto: CreateCycleDto,
  ) {
    return this.cycleService.createCycle(projectId, userId, createCycleDto);
  }

  @Get([
    'projects/:projectId/cycles/:cycleId',
    'project/:projectId/cycles/:cycleId',
    'cycles/:cycleId',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor', 'commenter', 'viewer')
  @ApiOperation({ summary: 'Get details of a cycle' })
  @ApiResponse({ status: 200, description: 'Cycle detail with tasks' })
  async getCycle(@Param('cycleId') cycleId: string) {
    return this.cycleService.getCycle(cycleId);
  }

  @Get([
    'projects/:projectId/cycles/:cycleId/progress',
    'project/:projectId/cycles/:cycleId/progress',
    'cycles/:cycleId/progress',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor', 'commenter', 'viewer')
  @ApiOperation({ summary: 'Get cycle burn-down and progress breakdown' })
  @ApiResponse({
    status: 200,
    description: 'Progress stats across state groups',
  })
  async getCycleProgress(@Param('cycleId') cycleId: string) {
    return this.cycleService.getCycleProgress(cycleId);
  }

  @Patch([
    'projects/:projectId/cycles/:cycleId',
    'project/:projectId/cycles/:cycleId',
    'cycles/:cycleId',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor')
  @ApiOperation({ summary: 'Update a cycle (PATCH)' })
  @ApiResponse({ status: 200, description: 'Updated cycle object' })
  async patchCycle(
    @Param('cycleId') cycleId: string,
    @Body() updateCycleDto: UpdateCycleDto,
  ) {
    return this.cycleService.updateCycle(cycleId, updateCycleDto);
  }

  @Put([
    'projects/:projectId/cycles/:cycleId',
    'project/:projectId/cycles/:cycleId',
    'cycles/:cycleId',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor')
  @ApiOperation({ summary: 'Update a cycle (PUT alias)' })
  @ApiResponse({ status: 200, description: 'Updated cycle object' })
  async updateCycle(
    @Param('cycleId') cycleId: string,
    @Body() updateCycleDto: UpdateCycleDto,
  ) {
    return this.cycleService.updateCycle(cycleId, updateCycleDto);
  }

  @Delete([
    'projects/:projectId/cycles/:cycleId',
    'project/:projectId/cycles/:cycleId',
    'cycles/:cycleId',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor')
  @ApiOperation({ summary: 'Soft-delete a cycle' })
  @ApiResponse({ status: 200, description: 'Cycle deletion confirmation' })
  async deleteCycle(@Param('cycleId') cycleId: string) {
    return this.cycleService.deleteCycle(cycleId);
  }

  @Post([
    'projects/:projectId/cycles/:cycleId/restore',
    'project/:projectId/cycles/:cycleId/restore',
    'cycles/:cycleId/restore',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor')
  @ApiOperation({ summary: 'Restore a soft-deleted cycle' })
  @ApiResponse({ status: 200, description: 'Cycle restored' })
  async restoreCycle(@Param('cycleId') cycleId: string) {
    return this.cycleService.restoreCycle(cycleId);
  }

  @Post([
    'projects/:projectId/cycles/:cycleId/tasks',
    'project/:projectId/cycles/:cycleId/tasks',
    'cycles/:cycleId/tasks',
  ])
  @HttpCode(HttpStatus.OK)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor')
  @ApiOperation({ summary: 'Add a work item to a cycle' })
  @ApiResponse({ status: 200, description: 'Updated cycle object' })
  async addTask(
    @Param('cycleId') cycleId: string,
    @Body() addCycleTaskDto: AddCycleTaskDto,
  ) {
    return this.cycleService.addTask(cycleId, addCycleTaskDto.taskId);
  }

  @Post([
    'projects/:projectId/cycles/:cycleId/tasks/batch',
    'project/:projectId/cycles/:cycleId/tasks/batch',
  ])
  @HttpCode(HttpStatus.OK)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor')
  @ApiOperation({ summary: 'Add multiple work items to a cycle in batch' })
  @ApiResponse({ status: 200, description: 'Batch addition summary' })
  async addTasksBatch(
    @Param('cycleId') cycleId: string,
    @Body() addCycleTasksBatchDto: AddCycleTasksBatchDto,
  ) {
    return this.cycleService.addTasksBatch(cycleId, addCycleTasksBatchDto.taskIds);
  }

  @Delete([
    'projects/:projectId/cycles/:cycleId/tasks/:taskId',
    'project/:projectId/cycles/:cycleId/tasks/:taskId',
    'cycles/:cycleId/tasks/:taskId',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor')
  @ApiOperation({ summary: 'Remove a work item from a cycle' })
  @ApiResponse({ status: 200, description: 'Task removal confirmation' })
  async removeTask(
    @Param('cycleId') cycleId: string,
    @Param('taskId') taskId: string,
  ) {
    return this.cycleService.removeTask(cycleId, taskId);
  }

  @Post([
    'projects/:projectId/cycles/:cycleId/complete',
    'project/:projectId/cycles/:cycleId/complete',
    'cycles/:cycleId/complete',
  ])
  @HttpCode(HttpStatus.OK)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor')
  @ApiOperation({ summary: 'Complete a cycle and handle incomplete tasks' })
  @ApiResponse({ status: 200, description: 'Completed cycle summary' })
  async completeCycle(
    @Param('cycleId') cycleId: string,
    @Body() completeCycleDto: CompleteCycleDto,
  ) {
    return this.cycleService.completeCycle(cycleId, completeCycleDto);
  }

  @Post([
    'projects/:projectId/cycles/auto-transition',
    'project/:projectId/cycles/auto-transition',
  ])
  @HttpCode(HttpStatus.OK)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor')
  @ApiOperation({
    summary:
      'Auto transition cycles based on dates (auto-start / auto-complete)',
  })
  @ApiResponse({ status: 200, description: 'Transition result summary' })
  async autoTransitionCycles(@Param('projectId') projectId: string) {
    return this.cycleService.processAutoTransitions(projectId);
  }

  @Get([
    'projects/:projectId/cycles/:cycleId/burndown',
    'project/:projectId/cycles/:cycleId/burndown',
    'cycles/:cycleId/burndown',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor', 'commenter', 'viewer')
  @ApiOperation({ summary: 'Get daily burn-down progress for a cycle' })
  @ApiResponse({ status: 200, description: 'Daily burn-down data' })
  async getCycleBurndown(@Param('cycleId') cycleId: string) {
    return this.cycleService.getCycleBurndown(cycleId);
  }

  @Get([
    'projects/:projectId/cycles/:cycleId/velocity',
    'project/:projectId/cycles/:cycleId/velocity',
    'cycles/:cycleId/velocity',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor', 'commenter', 'viewer')
  @ApiOperation({ summary: 'Get story points velocity metrics for a cycle' })
  @ApiResponse({ status: 200, description: 'Cycle velocity metrics' })
  async getCycleVelocity(@Param('cycleId') cycleId: string) {
    return this.cycleService.getCycleVelocity(cycleId);
  }
}
