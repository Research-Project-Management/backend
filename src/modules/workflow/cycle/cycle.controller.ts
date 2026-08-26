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

  @Get('project/:projectId/cycles')
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

  @Post('project/:projectId/cycles')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor')
  @ApiOperation({ summary: 'Create a new cycle in a project' })
  @ApiResponse({ status: 201, description: 'Created cycle object' })
  async createCycle(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CreateCycleDto,
  ) {
    return this.cycleService.createCycle(projectId, userId, dto);
  }

  @Get(['project/:projectId/cycles/:cycleId', 'cycles/:cycleId'])
  @ApiOperation({ summary: 'Get details of a cycle' })
  @ApiResponse({ status: 200, description: 'Cycle detail with tasks' })
  async getCycle(@Param('cycleId') cycleId: string) {
    return this.cycleService.getCycle(cycleId);
  }

  @Put(['project/:projectId/cycles/:cycleId', 'cycles/:cycleId'])
  @ApiOperation({ summary: 'Update a cycle' })
  @ApiResponse({ status: 200, description: 'Updated cycle object' })
  async updateCycle(
    @Param('cycleId') cycleId: string,
    @Body() dto: UpdateCycleDto,
  ) {
    return this.cycleService.updateCycle(cycleId, dto);
  }

  @Delete(['project/:projectId/cycles/:cycleId', 'cycles/:cycleId'])
  @ApiOperation({ summary: 'Soft-delete a cycle' })
  @ApiResponse({ status: 200, description: 'Cycle deletion confirmation' })
  async deleteCycle(@Param('cycleId') cycleId: string) {
    return this.cycleService.deleteCycle(cycleId);
  }

  @Post([
    'project/:projectId/cycles/:cycleId/restore',
    'cycles/:cycleId/restore',
  ])
  @ApiOperation({ summary: 'Restore a soft-deleted cycle' })
  @ApiResponse({ status: 200, description: 'Cycle restored' })
  async restoreCycle(@Param('cycleId') cycleId: string) {
    return this.cycleService.restoreCycle(cycleId);
  }

  @Post(['project/:projectId/cycles/:cycleId/tasks', 'cycles/:cycleId/tasks'])
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Add a task to a cycle' })
  @ApiResponse({ status: 200, description: 'Updated cycle object' })
  async addTask(
    @Param('cycleId') cycleId: string,
    @Body() dto: AddCycleTaskDto,
  ) {
    return this.cycleService.addTask(cycleId, dto.taskId);
  }

  @Delete([
    'project/:projectId/cycles/:cycleId/tasks/:taskId',
    'cycles/:cycleId/tasks/:taskId',
  ])
  @ApiOperation({ summary: 'Remove a task from a cycle' })
  @ApiResponse({ status: 200, description: 'Updated cycle object' })
  async removeTask(
    @Param('cycleId') cycleId: string,
    @Param('taskId') taskId: string,
  ) {
    return this.cycleService.removeTask(cycleId, taskId);
  }

  @Post([
    'project/:projectId/cycles/:cycleId/complete',
    'cycles/:cycleId/complete',
  ])
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Complete a cycle and handle incomplete tasks' })
  @ApiResponse({ status: 200, description: 'Completed cycle summary' })
  async completeCycle(
    @Param('cycleId') cycleId: string,
    @Body() dto: CompleteCycleDto,
  ) {
    return this.cycleService.completeCycle(cycleId, dto);
  }
}
