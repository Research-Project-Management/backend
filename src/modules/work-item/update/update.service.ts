import { Injectable, NotFoundException, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@/core/database/prisma.service';
import { RedisCacheService } from '@/core/cache/redis.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { randomUUID } from 'crypto';
import { isUuid } from '@/core/utils/uuid.util';
import { CreateWorkItemUpdateDto } from './dto/update.dto';
import { WorkItemUpdate } from './types/update.types';
import { WORK_ITEM_REDIS_KEYS } from '../core/constants/redis-keys.constant';

@Injectable()
export class UpdateService {
  constructor(
    private readonly prismaService: PrismaService,
    @Optional() private readonly cache?: RedisCacheService,
    @Optional() private readonly eventEmitter?: EventEmitter2,
  ) {}

  private async findWorkItem(workItemId: string) {
    if (isUuid(workItemId) || !this.prismaService.workItem?.findFirst) {
      return this.prismaService.workItem.findUnique({
        where: { id: workItemId },
        select: { id: true, projectId: true, updates: true },
      });
    }
    return this.prismaService.workItem.findFirst({
      where: {
        identifier: { equals: workItemId, mode: 'insensitive' },
        deletedAt: null,
      },
      select: { id: true, projectId: true, updates: true },
    });
  }

  /**
   * Parse raw JSON updates field from a WorkItem record.
   */
  private parseUpdates(raw: unknown): WorkItemUpdate[] {
    if (!Array.isArray(raw)) return [];
    return raw;
  }

  /**
   * Get all status updates for a work item, newest first.
   */
  async getUpdates(workItemId: string): Promise<{ updates: WorkItemUpdate[] }> {
    const workItem = await this.findWorkItem(workItemId);

    if (!workItem) throw new NotFoundException('Work item not found');

    const updates = this.parseUpdates(workItem.updates).sort(
      (firstUpdate: WorkItemUpdate, secondUpdate: WorkItemUpdate) =>
        new Date(secondUpdate.createdAt).getTime() -
        new Date(firstUpdate.createdAt).getTime(),
    );

    return { updates };
  }

  /**
   * Add a new status update to a work item.
   * Keeps a rolling window of the last 20 updates.
   */
  async addUpdate(
    workItemId: string,
    authorId: string,
    createWorkItemUpdateDto: CreateWorkItemUpdateDto,
  ): Promise<{ update: WorkItemUpdate; updates: WorkItemUpdate[] }> {
    const workItem = await this.findWorkItem(workItemId);

    if (!workItem) throw new NotFoundException('Work item not found');

    const existing = this.parseUpdates(workItem.updates);

    const newUpdate: WorkItemUpdate = {
      id: randomUUID(),
      status: createWorkItemUpdateDto.status,
      comment: createWorkItemUpdateDto.comment || null,
      authorId,
      createdAt: new Date().toISOString(),
    };

    // Keep last 20 updates (FIFO rolling window)
    const updated = [newUpdate, ...existing].slice(0, 20);

    await this.prismaService.workItem.update({
      where: { id: workItem.id },
      data: { updates: updated as unknown as Prisma.InputJsonValue },
    });

    // Invalidate WorkItem cache
    if (this.cache) {
      await Promise.all([
        this.cache.del(WORK_ITEM_REDIS_KEYS.workItem(workItem.id)),
        this.cache.del(
          WORK_ITEM_REDIS_KEYS.projectWorkItems(workItem.projectId),
        ),
      ]).catch(() => null);
    }

    const updatePayload = {
      entityType: 'work_item',
      entityId: workItem.id,
      workItemId: workItem.id,
      status: createWorkItemUpdateDto.status,
      authorId,
      projectId: workItem.projectId,
      verb: 'updated',
    };
    this.eventEmitter?.emit('work-item.update.added', updatePayload);
    this.eventEmitter?.emit('work-item.updated', updatePayload);

    return { update: newUpdate, updates: updated };
  }

  /**
   * Delete a specific status update from a work item.
   */
  async deleteUpdate(
    workItemId: string,
    updateId: string,
    actorId: string,
  ): Promise<{ success: boolean; updates: WorkItemUpdate[] }> {
    const workItem = await this.findWorkItem(workItemId);

    if (!workItem) throw new NotFoundException('Work item not found');

    const existing = this.parseUpdates(workItem.updates);
    const target = existing.find(
      (updateItem: WorkItemUpdate) => updateItem.id === updateId,
    );

    if (!target) throw new NotFoundException('Update not found');

    const filtered = existing.filter(
      (updateItem: WorkItemUpdate) => updateItem.id !== updateId,
    );

    await this.prismaService.workItem.update({
      where: { id: workItem.id },
      data: { updates: filtered as unknown as Prisma.InputJsonValue },
    });

    if (this.cache) {
      await Promise.all([
        this.cache.del(WORK_ITEM_REDIS_KEYS.workItem(workItem.id)),
        this.cache.del(
          WORK_ITEM_REDIS_KEYS.projectWorkItems(workItem.projectId),
        ),
      ]).catch(() => null);
    }

    return { success: true, updates: filtered };
  }

  /**
   * Get the latest (most recent) status update for a work item.
   */
  async getLatestUpdate(
    workItemId: string,
  ): Promise<{ update: WorkItemUpdate | null }> {
    const { updates } = await this.getUpdates(workItemId);
    return { update: updates[0] ?? null };
  }
}
