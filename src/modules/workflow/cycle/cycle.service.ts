import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { CycleRepository } from './cycle.repository';
import { TaskService } from '../task/task.service';
import {
  CreateCycleDto,
  UpdateCycleDto,
  CompleteCycleDto,
  IncompleteTaskAction,
} from './dto/cycle.dto';
import { CycleStatus, CyclePhase, Prisma } from '@prisma/client';

@Injectable()
export class CycleService {
  constructor(
    private readonly cycleRepo: CycleRepository,
    @Inject(forwardRef(() => TaskService))
    private readonly taskService: TaskService,
  ) {}

  private calculateStats(tasks: Array<{ columnId: string; completed?: boolean }>) {
    const total = tasks.length;
    const completed = tasks.filter(
      (t) => t.columnId === 'done' || t.completed === true,
    ).length;
    const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;
    return {
      totalTasks: total,
      completedTasks: completed,
      completionPercentage: percentage,
    };
  }

  private async ensureCycleExpiration(cycle: any) {
    if (!cycle) return cycle;

    const now = new Date();
    if (
      cycle.status === CycleStatus.active &&
      cycle.endDate &&
      new Date(cycle.endDate) < now
    ) {
      const tasks = cycle.tasks || (await this.cycleRepo.findCycleTasks(cycle.id));
      const stats = this.calculateStats(tasks);
      return this.cycleRepo.updateCycle(cycle.id, {
        status: CycleStatus.completed,
        endedAt: now,
        statsAtCompletion: stats as Prisma.InputJsonValue,
      });
    }

    return cycle;
  }

  async getCycles(projectId: string) {
    const cycles = await this.cycleRepo.findProjectCycles(projectId);
    const processed = await Promise.all(
      cycles.map((cycle) => this.ensureCycleExpiration(cycle)),
    );
    return { cycles: processed };
  }

  async getCycle(cycleId: string) {
    const cycle = await this.cycleRepo.findCycleById(cycleId);

    if (!cycle) {
      throw new NotFoundException('Cycle not found');
    }

    const processed = await this.ensureCycleExpiration(cycle);
    return { cycle: processed };
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
    const isCompleting = dto.status === CycleStatus.completed;
    let statsAtCompletion: any = undefined;
    let endedAt: Date | undefined = undefined;

    if (isCompleting) {
      const tasks = await this.cycleRepo.findCycleTasks(cycleId);
      statsAtCompletion = this.calculateStats(tasks);
      endedAt = new Date();
    }

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
      ...(statsAtCompletion !== undefined && {
        statsAtCompletion: statsAtCompletion as Prisma.InputJsonValue,
      }),
      ...(endedAt !== undefined && { endedAt }),
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

  async completeCycle(cycleId: string, dto: CompleteCycleDto) {
    const cycle = await this.cycleRepo.findCycleById(cycleId);
    if (!cycle) {
      throw new NotFoundException('Cycle not found');
    }

    const tasks = await this.cycleRepo.findCycleTasks(cycleId);
    const stats = this.calculateStats(tasks);

    let transferredCount = 0;

    if (dto.action === IncompleteTaskAction.transfer) {
      if (!dto.targetCycleId) {
        throw new BadRequestException('Target cycle ID is required for task transfer');
      }
      if (dto.targetCycleId === cycleId) {
        throw new BadRequestException('Cannot transfer tasks to the same cycle');
      }

      const target = await this.cycleRepo.findCycleById(dto.targetCycleId);
      if (!target || target.projectId !== cycle.projectId) {
        throw new BadRequestException('Target cycle not found in this project');
      }
      if (target.status === CycleStatus.completed) {
        throw new BadRequestException('Cannot transfer tasks to an already completed cycle');
      }

      const result = await this.cycleRepo.transferIncompleteTasks(
        cycleId,
        dto.targetCycleId,
      );
      transferredCount = result.count;
    } else if (dto.action === IncompleteTaskAction.backlog) {
      const result = await this.cycleRepo.transferIncompleteTasks(cycleId, null);
      transferredCount = result.count;
    }

    const updatedCycle = await this.cycleRepo.updateCycle(cycleId, {
      status: CycleStatus.completed,
      endedAt: new Date(),
      statsAtCompletion: stats as Prisma.InputJsonValue,
    });

    return {
      cycle: updatedCycle,
      transferredCount,
      action: dto.action,
      message: 'Cycle completed successfully',
    };
  }
}
