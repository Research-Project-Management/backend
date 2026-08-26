import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Inject,
  forwardRef,
  Optional,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CycleRepository } from './cycle.repository';
import { TaskService } from '../task/task.service';
import {
  CreateCycleDto,
  UpdateCycleDto,
  CompleteCycleDto,
  IncompleteTaskAction,
} from './dto/cycle.dto';
import { CycleStatus, CyclePhase, Prisma, EntityType } from '@prisma/client';
import { DomainActivityEvent } from '@/modules/activity/events/activity.events';
import { RedisCacheService } from '@/core/cache/redis-cache.service';
import { WORKFLOW_REDIS_KEYS } from '../constants/redis-keys.constant';

@Injectable()
export class CycleService {
  constructor(
    private readonly cycleRepo: CycleRepository,
    @Inject(forwardRef(() => TaskService))
    private readonly taskService: TaskService,
    @Optional() private readonly eventEmitter?: EventEmitter2,
    @Optional() private readonly cache?: RedisCacheService,
  ) {}

  private async invalidateCycleCache(projectId: string, cycleId?: string) {
    if (!this.cache) return;
    await Promise.all([
      this.cache.del(WORKFLOW_REDIS_KEYS.projectCycles(projectId)),
      cycleId
        ? this.cache.del(WORKFLOW_REDIS_KEYS.cycle(cycleId))
        : Promise.resolve(),
    ]);
  }

  private calculateStats(
    tasks: Array<{ columnId: string; completed?: boolean }>,
  ) {
    const total = tasks.length;
    const completed = tasks.filter(
      (taskItem) => taskItem.columnId === 'done' || taskItem.completed === true,
    ).length;
    const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;
    return {
      totalTasks: total,
      completedTasks: completed,
      completionPercentage: percentage,
    };
  }

  async getCycles(projectId: string) {
    const cacheKey = WORKFLOW_REDIS_KEYS.projectCycles(projectId);

    if (this.cache) {
      return this.cache.wrap(
        cacheKey,
        async () => {
          const cycles = await this.cycleRepo.findProjectCycles(projectId);
          return { cycles };
        },
        3600,
      );
    }

    const cycles = await this.cycleRepo.findProjectCycles(projectId);
    return { cycles };
  }

  async getCycle(cycleId: string) {
    const cacheKey = WORKFLOW_REDIS_KEYS.cycle(cycleId);
    let cycle = this.cache ? await this.cache.get<any>(cacheKey) : null;

    if (!cycle) {
      cycle = await this.cycleRepo.findCycleById(cycleId);
      if (!cycle) {
        throw new NotFoundException('Cycle not found');
      }
      if (this.cache) {
        await this.cache.set(cacheKey, cycle, 1800);
      }
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
      project: { connect: { id: projectId } },
      author: { connect: { id: userId } },
    });

    await this.invalidateCycleCache(projectId, cycle.id);

    this.eventEmitter?.emit(
      'cycle.created',
      new DomainActivityEvent({
        entityType: 'cycle' as unknown as EntityType,
        entityId: cycle.id,
        verb: 'created',
        actorId: userId,
        projectId,
      }),
    );

    return { cycle };
  }

  async updateCycle(cycleId: string, dto: UpdateCycleDto) {
    const existing = await this.cycleRepo.findCycleById(cycleId);
    if (!existing) {
      throw new NotFoundException('Cycle not found');
    }

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

    await this.invalidateCycleCache(existing.projectId, cycleId);

    this.eventEmitter?.emit(
      'cycle.updated',
      new DomainActivityEvent({
        entityType: 'cycle' as unknown as EntityType,
        entityId: cycle.id,
        verb: isCompleting ? 'completed' : 'updated',
        actorId: '',
        projectId: cycle.projectId,
      }),
    );

    return { cycle };
  }

  async deleteCycle(cycleId: string) {
    const existing = await this.cycleRepo.findCycleById(cycleId);
    if (!existing) {
      throw new NotFoundException('Cycle not found');
    }

    await this.cycleRepo.softDeleteCycle(cycleId);
    await this.invalidateCycleCache(existing.projectId, cycleId);

    this.eventEmitter?.emit(
      'cycle.deleted',
      new DomainActivityEvent({
        entityType: 'cycle' as unknown as EntityType,
        entityId: cycleId,
        verb: 'deleted',
        actorId: '',
        projectId: existing.projectId,
      }),
    );

    return { message: 'Cycle soft-deleted successfully' };
  }

  async restoreCycle(cycleId: string) {
    const restored = await this.cycleRepo.restoreCycle(cycleId);
    await this.invalidateCycleCache(restored.projectId, cycleId);
    return {
      message: 'Cycle restored successfully',
      cycle: restored,
    };
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
        throw new BadRequestException(
          'Target cycle ID is required for task transfer',
        );
      }
      if (dto.targetCycleId === cycleId) {
        throw new BadRequestException(
          'Cannot transfer tasks to the same cycle',
        );
      }

      const target = await this.cycleRepo.findCycleById(dto.targetCycleId);
      if (!target || target.projectId !== cycle.projectId) {
        throw new BadRequestException('Target cycle not found in this project');
      }
      if (target.status === CycleStatus.completed) {
        throw new BadRequestException(
          'Cannot transfer tasks to an already completed cycle',
        );
      }

      const result = await this.cycleRepo.transferIncompleteTasks(
        cycleId,
        dto.targetCycleId,
      );
      transferredCount = result.count;
    } else if (dto.action === IncompleteTaskAction.backlog) {
      const result = await this.cycleRepo.transferIncompleteTasks(
        cycleId,
        null,
      );
      transferredCount = result.count;
    }

    const updatedCycle = await this.cycleRepo.updateCycle(cycleId, {
      status: CycleStatus.completed,
      endedAt: new Date(),
      statsAtCompletion: stats as Prisma.InputJsonValue,
    });

    await Promise.all([
      this.invalidateCycleCache(cycle.projectId, cycleId),
      ...(dto.targetCycleId
        ? [this.invalidateCycleCache(cycle.projectId, dto.targetCycleId)]
        : []),
      this.cache?.del(WORKFLOW_REDIS_KEYS.projectTasks(cycle.projectId)),
      this.cache?.del(`flux:proj:overview:${cycle.projectId}`),
    ]);

    this.eventEmitter?.emit(
      'cycle.completed',
      new DomainActivityEvent({
        entityType: 'cycle' as unknown as EntityType,
        entityId: cycleId,
        verb: 'completed',
        actorId: '',
        projectId: cycle.projectId,
      }),
    );

    return {
      cycle: updatedCycle,
      transferredCount,
      action: dto.action,
      message: 'Cycle completed successfully',
    };
  }
}
