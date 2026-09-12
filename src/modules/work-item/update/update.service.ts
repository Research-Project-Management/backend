import {
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@/core/database/prisma.service';
import { RedisCacheService } from '@/core/cache/redis-cache.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { randomUUID } from 'crypto';
import {
  CreateWorkItemUpdateDto,
} from './dto/update.dto';
import { WorkItemUpdate } from './types/update.types';
import { WORK_ITEM_REDIS_KEYS } from '../core/constants/redis-keys.constant';

@Injectable()
export class UpdateService {
  constructor(
    private readonly prismaService: PrismaService,
    @Optional() private readonly cache?: RedisCacheService,
    @Optional() private readonly eventEmitter?: EventEmitter2,
  ) {}

  /**
   * Parse raw JSON updates field from a Task record.
   */
  private parseUpdates(raw: unknown): WorkItemUpdate[] {
    if (!Array.isArray(raw)) return [];
    return raw as unknown as WorkItemUpdate[];
  }

  /**
   * Get all status updates for a work item, newest first.
   */
  async getUpdates(taskId: string): Promise<{ updates: WorkItemUpdate[] }> {
    const task = await this.prismaService.task.findUnique({
      where: { id: taskId },
      select: { id: true, updates: true },
    });

    if (!task) throw new NotFoundException('Work item not found');

    const updates = this.parseUpdates(task.updates).sort(
      (firstUpdate: WorkItemUpdate, secondUpdate: WorkItemUpdate) =>
        new Date(secondUpdate.createdAt).getTime() - new Date(firstUpdate.createdAt).getTime(),
    );

    return { updates };
  }

  /**
   * Add a new status update to a work item.
   * Keeps a rolling window of the last 20 updates.
   */
  async addUpdate(
    taskId: string,
    authorId: string,
    createWorkItemUpdateDto: CreateWorkItemUpdateDto,
  ): Promise<{ update: WorkItemUpdate; updates: WorkItemUpdate[] }> {
    const task = await this.prismaService.task.findUnique({
      where: { id: taskId },
      select: { id: true, projectId: true, updates: true },
    });

    if (!task) throw new NotFoundException('Work item not found');

    const existing = this.parseUpdates(task.updates);

    const newUpdate: WorkItemUpdate = {
      id: randomUUID(),
      status: createWorkItemUpdateDto.status,
      comment: createWorkItemUpdateDto.comment || null,
      authorId,
      createdAt: new Date().toISOString(),
    };

    // Keep last 20 updates (FIFO rolling window)
    const updated = [newUpdate, ...existing].slice(0, 20);

    await this.prismaService.task.update({
      where: { id: taskId },
      data: { updates: updated as unknown as Prisma.InputJsonValue },
    });

    // Invalidate task cache
    if (this.cache) {
      await Promise.all([
        this.cache.del(WORK_ITEM_REDIS_KEYS.task(taskId)),
        this.cache.del(WORK_ITEM_REDIS_KEYS.projectTasks(task.projectId)),
      ]).catch(() => null);
    }

    this.eventEmitter?.emit('task.update.added', {
      taskId,
      status: createWorkItemUpdateDto.status,
      authorId,
      projectId: task.projectId,
    });

    return { update: newUpdate, updates: updated };
  }

  /**
   * Delete a specific status update from a work item.
   */
  async deleteUpdate(
    taskId: string,
    updateId: string,
    actorId: string,
  ): Promise<{ success: boolean; updates: WorkItemUpdate[] }> {
    const task = await this.prismaService.task.findUnique({
      where: { id: taskId },
      select: { id: true, projectId: true, updates: true },
    });

    if (!task) throw new NotFoundException('Work item not found');

    const existing = this.parseUpdates(task.updates);
    const target = existing.find((updateItem: WorkItemUpdate) => updateItem.id === updateId);

    if (!target) throw new NotFoundException('Update not found');

    const filtered = existing.filter((updateItem: WorkItemUpdate) => updateItem.id !== updateId);

    await this.prismaService.task.update({
      where: { id: taskId },
      data: { updates: filtered as unknown as Prisma.InputJsonValue },
    });

    if (this.cache) {
      await Promise.all([
        this.cache.del(WORK_ITEM_REDIS_KEYS.task(taskId)),
        this.cache.del(WORK_ITEM_REDIS_KEYS.projectTasks(task.projectId)),
      ]).catch(() => null);
    }

    return { success: true, updates: filtered };
  }

  /**
   * Get the latest (most recent) status update for a work item.
   */
  async getLatestUpdate(taskId: string): Promise<{ update: WorkItemUpdate | null }> {
    const { updates } = await this.getUpdates(taskId);
    return { update: updates[0] ?? null };
  }
}

