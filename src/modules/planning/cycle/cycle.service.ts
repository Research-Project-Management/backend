import {
  Injectable,
  NotFoundException,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { CycleRepository } from './cycle.repository';
import { TaskService } from '../task/task.service';
import { CreateCycleDto, UpdateCycleDto } from './dto/cycle.dto';
import { CycleStatus, CyclePhase } from '@prisma/client';

@Injectable()
export class CycleService {
  constructor(
    private readonly cycleRepo: CycleRepository,
    @Inject(forwardRef(() => TaskService))
    private readonly taskService: TaskService,
  ) {}

  async getCycles(projectId: string) {
    const cycles = await this.cycleRepo.findProjectCycles(projectId);
    return { cycles };
  }

  async getCycle(cycleId: string) {
    const cycle = await this.cycleRepo.findCycleById(cycleId);

    if (!cycle) {
      throw new NotFoundException('Cycle not found');
    }

    return { cycle };
  }

  async createCycle(projectId: string, userId: string, dto: CreateCycleDto) {
    const cycle = await this.cycleRepo.createCycle({
      name: dto.name,
      description: dto.description || '',
      startDate: dto.startDate ? new Date(dto.startDate) : null,
      endDate: dto.endDate ? new Date(dto.endDate) : null,
      status: dto.status || CycleStatus.planned,
      phase: dto.phase || CyclePhase.custom,
      projectId,
      authorId: userId,
    });

    return { cycle };
  }

  async updateCycle(cycleId: string, dto: UpdateCycleDto) {
    const cycle = await this.cycleRepo.updateCycle(cycleId, {
      ...(dto.name !== undefined && { name: dto.name }),
      ...(dto.description !== undefined && { description: dto.description }),
      ...(dto.startDate !== undefined && {
        startDate: dto.startDate ? new Date(dto.startDate) : null,
      }),
      ...(dto.endDate !== undefined && {
        endDate: dto.endDate ? new Date(dto.endDate) : null,
      }),
      ...(dto.status !== undefined && { status: dto.status }),
      ...(dto.phase !== undefined && { phase: dto.phase }),
    });

    return { cycle };
  }

  async deleteCycle(cycleId: string) {
    await this.cycleRepo.deleteCycle(cycleId);
    return { message: 'Cycle deleted successfully' };
  }

  async addTask(cycleId: string, taskId: string) {
    const updated = await this.taskService.updateTask(taskId, { cycleId });
    return { message: 'Task added to cycle', task: updated.task };
  }

  async removeTask(cycleId: string, taskId: string) {
    const updated = await this.taskService.updateTask(taskId, {
      cycleId: null,
    });
    return {
      message: 'Task removed from cycle',
      task: updated.task,
    };
  }
}
