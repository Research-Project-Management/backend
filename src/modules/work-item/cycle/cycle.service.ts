import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Optional,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CycleRepository } from './cycle.repository';
import {
  CreateCycleDto,
  UpdateCycleDto,
  CompleteCycleDto,
  IncompleteTaskAction,
} from './dto/cycle.dto';
import {
  Cycle,
  CycleStatus,
  CyclePhase,
  Prisma,
  EntityType,
} from '@prisma/client';
import { RedisCacheService } from '@/core/cache/redis-cache.service';
import { WORK_ITEM_REDIS_KEYS } from '../core/constants/redis-keys.constant';
import { calculateCycleStats } from './utils/cycle.util';
import { CycleStats, CycleTaskItem } from './types/cycle.types';
import { inferStateGroup } from '../state/utils/state.util';

@Injectable()
export class CycleService implements OnModuleInit, OnModuleDestroy {
  private cronIntervalTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly cycleRepository: CycleRepository,
    @Optional() private readonly eventEmitter?: EventEmitter2,
    @Optional() private readonly cache?: RedisCacheService,
  ) {}

  onModuleInit() {
    this.cronIntervalTimer = setInterval(
      () => {
        this.processAutoTransitions().catch(() => {});
      },
      10 * 60 * 1000,
    );
    this.cronIntervalTimer.unref();
  }

  onModuleDestroy() {
    if (this.cronIntervalTimer) {
      clearInterval(this.cronIntervalTimer);
      this.cronIntervalTimer = null;
    }
  }

  private async invalidateCycleCache(projectId: string, cycleId?: string) {
    if (!this.cache) return;
    const promises: Promise<void>[] = [
      this.cache.del(WORK_ITEM_REDIS_KEYS.projectCycles(projectId)),
      this.cache.del(WORK_ITEM_REDIS_KEYS.projectTasks(projectId)),
      this.cache.del(`flux:proj:overview:${projectId}`),
    ];
    if (cycleId) {
      promises.push(this.cache.del(WORK_ITEM_REDIS_KEYS.cycle(cycleId)));
    }
    await Promise.all(promises);
  }

  private validateDates(startDate?: Date | null, endDate?: Date | null): void {
    if (startDate && endDate && startDate > endDate) {
      throw new BadRequestException('End date must be on or after start date');
    }
  }

  private async ensureNoActiveCycleConflict(
    projectId: string,
    excludeCycleId?: string,
  ): Promise<void> {
    const existingActive = await this.cycleRepository.findActiveCycle(
      projectId,
      excludeCycleId,
    );
    if (existingActive) {
      throw new ConflictException(
        `Another cycle is currently active in this project: "${existingActive.name}". Complete or pause the active cycle first.`,
      );
    }
  }

  private async ensureNoDateOverlap(
    projectId: string,
    startDate?: Date | null,
    endDate?: Date | null,
    excludeCycleId?: string,
  ): Promise<void> {
    if (!startDate || !endDate) return;
    const overlapping = await this.cycleRepository.findOverlappingCycle(
      projectId,
      startDate,
      endDate,
      excludeCycleId,
    );
    if (overlapping) {
      throw new ConflictException(
        `Cycle dates overlap with an existing cycle: "${overlapping.name}". By default, cycles cannot have overlapping dates.`,
      );
    }
  }

  async getCycles(projectId: string) {
    await this.processAutoTransitions(projectId);
    const cacheKey = WORK_ITEM_REDIS_KEYS.projectCycles(projectId);

    if (this.cache) {
      const cached = await this.cache.get<{ cycles: Cycle[] }>(cacheKey);
      if (cached) return cached;
    }

    const cycles = await this.cycleRepository.findProjectCycles(projectId);
    const result = { cycles };

    if (this.cache) {
      await this.cache.set(cacheKey, result, 1800);
    }
    return result;
  }

  async getCycle(cycleId: string) {
    const cacheKey = WORK_ITEM_REDIS_KEYS.cycle(cycleId);
    if (this.cache) {
      const cached = await this.cache.get<{ cycle: Cycle }>(cacheKey);
      if (cached) return cached;
    }

    const cycle = await this.cycleRepository.findCycleById(cycleId);
    if (!cycle) {
      throw new NotFoundException('Cycle not found');
    }

    const result = { cycle };
    if (this.cache) {
      await this.cache.set(cacheKey, result, 1800);
    }
    return result;
  }

  async getCycleProgress(cycleId: string): Promise<{ progress: CycleStats }> {
    const cycle = await this.cycleRepository.findCycleById(cycleId);
    if (!cycle) {
      throw new NotFoundException('Cycle not found');
    }

    const tasks = await this.cycleRepository.findCycleTasks(cycleId);
    const progress = calculateCycleStats(tasks);
    return { progress };
  }

  async createCycle(projectId: string, userId: string, dto: CreateCycleDto) {
    const startDate = dto.startDate ? new Date(dto.startDate) : null;
    const endDate = dto.endDate ? new Date(dto.endDate) : null;
    const status = dto.status || CycleStatus.planned;

    // 1. Validate date logic
    this.validateDates(startDate, endDate);

    // 2. Validate date overlap
    await this.ensureNoDateOverlap(projectId, startDate, endDate);

    // 3. Enforce single active cycle invariant
    if (status === CycleStatus.active) {
      await this.ensureNoActiveCycleConflict(projectId);
    }

    const cycle = await this.cycleRepository.createCycle({
      name: dto.name.trim(),
      description: dto.description?.trim() || '',
      startDate,
      endDate,
      status,
      phase: dto.phase || CyclePhase.custom,
      project: { connect: { id: projectId } },
      author: { connect: { id: userId } },
    });

    await this.invalidateCycleCache(projectId, cycle.id);

    this.eventEmitter?.emit('cycle.created', {
      entityType: 'cycle',
      entityId: cycle.id,
      verb: 'created',
      actorId: userId,
      projectId,
    });

    return { cycle };
  }

  async updateCycle(cycleId: string, dto: UpdateCycleDto) {
    const existing = await this.cycleRepository.findCycleById(cycleId);
    if (!existing) {
      throw new NotFoundException('Cycle not found');
    }

    const startDate =
      dto.startDate !== undefined
        ? dto.startDate
          ? new Date(dto.startDate)
          : null
        : existing.startDate;
    const endDate =
      dto.endDate !== undefined
        ? dto.endDate
          ? new Date(dto.endDate)
          : null
        : existing.endDate;

    // 1. Validate date logic if dates are updated
    if (dto.startDate !== undefined || dto.endDate !== undefined) {
      this.validateDates(startDate, endDate);
      await this.ensureNoDateOverlap(
        existing.projectId,
        startDate,
        endDate,
        cycleId,
      );
    }

    // 2. Single active cycle invariant check
    if (
      dto.status === CycleStatus.active &&
      existing.status !== CycleStatus.active
    ) {
      await this.ensureNoActiveCycleConflict(existing.projectId, cycleId);
    }

    const isCompleting = dto.status === CycleStatus.completed;
    let statsAtCompletion: CycleStats | undefined = undefined;
    let endedAt: Date | undefined = undefined;

    if (isCompleting) {
      const tasks = await this.cycleRepository.findCycleTasks(cycleId);
      statsAtCompletion = calculateCycleStats(tasks);
      endedAt = new Date();
    }

    const cycle = await this.cycleRepository.updateCycle(cycleId, {
      ...(dto.name !== undefined && { name: dto.name.trim() }),
      ...(dto.description !== undefined && {
        description: dto.description?.trim(),
      }),
      ...(dto.startDate !== undefined && { startDate }),
      ...(dto.endDate !== undefined && { endDate }),
      ...(dto.status !== undefined && { status: dto.status }),
      ...(dto.phase !== undefined && { phase: dto.phase }),
      ...(statsAtCompletion !== undefined && {
        statsAtCompletion:
          statsAtCompletion as unknown as Prisma.InputJsonValue,
      }),
      ...(endedAt !== undefined && { endedAt }),
    });

    await this.invalidateCycleCache(existing.projectId, cycleId);

    this.eventEmitter?.emit('cycle.updated', {
      entityType: 'cycle',
      entityId: cycle.id,
      verb: isCompleting ? 'completed' : 'updated',
      actorId: '',
      projectId: cycle.projectId,
    });

    return { cycle };
  }

  async deleteCycle(cycleId: string) {
    const existing = await this.cycleRepository.findCycleById(cycleId);
    if (!existing) {
      throw new NotFoundException('Cycle not found');
    }

    await this.cycleRepository.softDeleteCycle(cycleId);
    await this.invalidateCycleCache(existing.projectId, cycleId);

    this.eventEmitter?.emit('cycle.deleted', {
      entityType: 'cycle',
      entityId: cycleId,
      verb: 'deleted',
      actorId: '',
      projectId: existing.projectId,
    });

    return { message: 'Cycle soft-deleted successfully' };
  }

  async restoreCycle(cycleId: string) {
    const restored = await this.cycleRepository.restoreCycle(cycleId);
    await this.invalidateCycleCache(restored.projectId, cycleId);
    return {
      message: 'Cycle restored successfully',
      cycle: restored,
    };
  }

  async addTask(cycleId: string, taskId: string) {
    const cycle = await this.cycleRepository.findCycleById(cycleId);
    if (!cycle) {
      throw new NotFoundException('Cycle not found');
    }
    const updated = await this.cycleRepository.addTaskToCycle(taskId, cycleId);
    await this.invalidateCycleCache(cycle.projectId, cycleId);
    return { message: 'Task added to cycle', task: updated };
  }

  async addTasksBatch(cycleId: string, taskIds: string[]) {
    const cycle = await this.cycleRepository.findCycleById(cycleId);
    if (!cycle) {
      throw new NotFoundException('Cycle not found');
    }
    const result = await this.cycleRepository.addTasksBatch(taskIds, cycleId);
    await this.invalidateCycleCache(cycle.projectId, cycleId);
    return {
      message: `${result.count} tasks added to cycle`,
      count: result.count,
    };
  }

  async removeTask(cycleId: string, taskId: string) {
    const cycle = await this.cycleRepository.findCycleById(cycleId);
    if (!cycle) {
      throw new NotFoundException('Cycle not found');
    }
    const updated = await this.cycleRepository.removeTaskFromCycle(taskId);
    await this.invalidateCycleCache(cycle.projectId, cycleId);
    return {
      message: 'Task removed from cycle',
      task: updated,
    };
  }

  async completeCycle(cycleId: string, dto: CompleteCycleDto) {
    const cycle = await this.cycleRepository.findCycleById(cycleId);
    if (!cycle) {
      throw new NotFoundException('Cycle not found');
    }

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
    }

    const tasks = await this.cycleRepository.findCycleTasks(cycleId);
    const stats = calculateCycleStats(tasks);

    // Identify incomplete tasks using state groups
    const incompleteTaskIds = tasks
      .filter(
        (task) =>
          !task.completed &&
          inferStateGroup(task.columnId, task.columnId) !== 'completed',
      )
      .map((task) => task.id);

    let transferredCount = 0;

    if (dto.action === IncompleteTaskAction.transfer) {
      const target = await this.cycleRepository.findCycleById(dto.targetCycleId!);
      if (!target || target.projectId !== cycle.projectId) {
        throw new BadRequestException('Target cycle not found in this project');
      }
      if (target.status === CycleStatus.completed) {
        throw new BadRequestException(
          'Cannot transfer tasks to an already completed cycle',
        );
      }

      if (incompleteTaskIds.length > 0) {
        const result = await this.cycleRepository.transferIncompleteTasks(
          cycleId,
          dto.targetCycleId!,
          incompleteTaskIds,
        );
        transferredCount = result.count;
      }
    } else if (dto.action === IncompleteTaskAction.backlog) {
      if (incompleteTaskIds.length > 0) {
        const result = await this.cycleRepository.transferIncompleteTasks(
          cycleId,
          null,
          incompleteTaskIds,
        );
        transferredCount = result.count;
      }
    }

    const updatedCycle = await this.cycleRepository.updateCycle(cycleId, {
      status: CycleStatus.completed,
      endedAt: new Date(),
      statsAtCompletion: stats as unknown as Prisma.InputJsonValue,
    });

    await Promise.all([
      this.invalidateCycleCache(cycle.projectId, cycleId),
      ...(dto.targetCycleId
        ? [this.invalidateCycleCache(cycle.projectId, dto.targetCycleId)]
        : []),
    ]);

    this.eventEmitter?.emit('cycle.completed', {
      entityType: 'cycle',
      entityId: cycleId,
      verb: 'completed',
      actorId: '',
      projectId: cycle.projectId,
    });

    return {
      cycle: updatedCycle,
      transferredCount,
      action: dto.action,
      message: 'Cycle completed successfully',
    };
  }

  async processAutoTransitions(projectId?: string) {
    const now = new Date();
    const completedCycles: any[] = [];
    const startedCycles: any[] = [];

    // 1. Auto-complete active cycles whose endDate has passed (< now)
    const eligibleToComplete =
      await this.cycleRepository.findCyclesEligibleForAutoComplete(now, projectId);
    for (const cycle of eligibleToComplete) {
      const tasks = await this.cycleRepository.findCycleTasks(cycle.id);
      const stats = calculateCycleStats(tasks);
      const updated = await this.cycleRepository.updateCycle(cycle.id, {
        status: CycleStatus.completed,
        endedAt: now,
        statsAtCompletion: stats as unknown as Prisma.InputJsonValue,
      });

      await this.invalidateCycleCache(cycle.projectId, cycle.id);

      this.eventEmitter?.emit('cycle.completed', {
        entityType: 'cycle',
        entityId: cycle.id,
        verb: 'completed',
        actorId: 'system:auto-transition',
        projectId: cycle.projectId,
      });
      completedCycles.push(updated);
    }

    // 2. Auto-start planned cycles where startDate <= now <= endDate
    // Note: A project should only have at most one active cycle at a time
    const eligibleToStart = await this.cycleRepository.findCyclesEligibleForAutoStart(
      now,
      projectId,
    );
    for (const cycle of eligibleToStart) {
      const hasActive = await this.cycleRepository.hasActiveCycle(cycle.projectId);
      if (!hasActive) {
        const updated = await this.cycleRepository.updateCycle(cycle.id, {
          status: CycleStatus.active,
          startedAt: now,
        });

        await this.invalidateCycleCache(cycle.projectId, cycle.id);

        this.eventEmitter?.emit('cycle.updated', {
          entityType: 'cycle',
          entityId: cycle.id,
          verb: 'started',
          actorId: 'system:auto-transition',
          projectId: cycle.projectId,
        });
        startedCycles.push(updated);
      }
    }

    return {
      autoCompletedCount: completedCycles.length,
      autoStartedCount: startedCycles.length,
      completedCycles,
      startedCycles,
    };
  }

  /**
   * Daily burn-down data for a cycle
   */
  async getCycleBurndown(cycleId: string): Promise<{
    cycleId: string;
    burndown: Array<{ date: string; remaining: number; completed: number }>;
  }> {
    const cycle = await this.cycleRepository.findCycleById(cycleId);
    if (!cycle) throw new NotFoundException('Cycle not found');

    const tasks = (cycle as any).tasks || [];
    const total = tasks.length;
    const startDate = cycle.startDate
      ? new Date(cycle.startDate)
      : new Date(cycle.createdAt);
    const endDate = cycle.endDate ? new Date(cycle.endDate) : new Date();
    const today = new Date();
    const chartEnd = endDate < today ? endDate : today;

    const burndown: Array<{
      date: string;
      remaining: number;
      completed: number;
    }> = [];
    const cursor = new Date(startDate);

    while (cursor <= chartEnd) {
      const dateStr = cursor.toISOString().slice(0, 10);
      const completedByDay = tasks.filter((taskItem: any) => {
        const group = inferStateGroup(taskItem.columnId, taskItem.columnId);
        const isDone = taskItem.completed === true || group === 'completed';
        if (!isDone) return false;
        const updatedDate = taskItem.updatedAt ? new Date(taskItem.updatedAt) : new Date();
        return updatedDate <= new Date(dateStr + 'T23:59:59Z');
      }).length;

      burndown.push({
        date: dateStr,
        remaining: Math.max(0, total - completedByDay),
        completed: completedByDay,
      });
      cursor.setDate(cursor.getDate() + 1);
    }

    return { cycleId, burndown };
  }

  /**
   * Story points and velocity for a cycle
   */
  async getCycleVelocity(cycleId: string): Promise<{
    cycleId: string;
    stats: CycleStats;
    velocityRate: number;
  }> {
    const cycle = await this.cycleRepository.findCycleById(cycleId);
    if (!cycle) throw new NotFoundException('Cycle not found');

    const tasks = (cycle as any).tasks || [];
    const stats = calculateCycleStats(tasks);
    const velocityRate = stats.completionPercentage;

    return {
      cycleId,
      stats,
      velocityRate,
    };
  }
}
