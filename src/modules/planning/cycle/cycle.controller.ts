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
import { CycleService } from './cycle.service';
import {
  CreateCycleDto,
  UpdateCycleDto,
  AddCycleTaskDto,
} from './dto/cycle.dto';
import { JwtAuthGuard } from '@/core/guards/jwt-auth.guard';
import { CurrentUser } from '@/core/decorators/current-user.decorator';

@ApiTags('Planning')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(JwtAuthGuard)
export class CycleController {
  constructor(private readonly cycleService: CycleService) {}

  @Get('project/:projectId/cycles')
  async getCycles(@Param('projectId') projectId: string) {
    return this.cycleService.getCycles(projectId);
  }

  @Post('project/:projectId/cycles')
  @HttpCode(HttpStatus.CREATED)
  async createCycle(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CreateCycleDto,
  ) {
    return this.cycleService.createCycle(projectId, userId, dto);
  }

  @Get(['project/:projectId/cycles/:cycleId', 'cycles/:cycleId'])
  async getCycle(@Param('cycleId') cycleId: string) {
    return this.cycleService.getCycle(cycleId);
  }

  @Put(['project/:projectId/cycles/:cycleId', 'cycles/:cycleId'])
  async updateCycle(
    @Param('cycleId') cycleId: string,
    @Body() dto: UpdateCycleDto,
  ) {
    return this.cycleService.updateCycle(cycleId, dto);
  }

  @Delete(['project/:projectId/cycles/:cycleId', 'cycles/:cycleId'])
  async deleteCycle(@Param('cycleId') cycleId: string) {
    return this.cycleService.deleteCycle(cycleId);
  }

  @Post(['project/:projectId/cycles/:cycleId/tasks', 'cycles/:cycleId/tasks'])
  @HttpCode(HttpStatus.OK)
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
  async removeTask(
    @Param('cycleId') cycleId: string,
    @Param('taskId') taskId: string,
  ) {
    return this.cycleService.removeTask(cycleId, taskId);
  }
}
