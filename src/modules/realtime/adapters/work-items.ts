import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { AccessService } from '@/modules/project/access';
import { WORK_ITEMS_EVENTS } from '../channels/work-items/config';
import { RealtimeEventBus } from '../core/bus';
import type { WorkItemsAccessPort } from '../ports/work-items';

@Injectable()
export class WorkItemsAccessAdapter implements WorkItemsAccessPort {
  constructor(private readonly accessService: AccessService) {}

  public async getRole(
    projectId: string,
    userId: string,
  ): Promise<string | null> {
    return this.accessService.getRole(projectId, userId);
  }

  public async invalidateAccessCache(
    projectId: string,
    userId: string,
  ): Promise<void> {
    await this.accessService.invalidateAccessCache(projectId, userId);
  }
}

@Injectable()
export class WorkItemsEventsBridge {
  constructor(private readonly realtimeBus: RealtimeEventBus) {}

  @OnEvent('work-item.created')
  public async handleWorkItemCreated(
    payload?: Record<string, unknown>,
  ): Promise<void> {
    await this.publishWorkItemEvent(payload, WORK_ITEMS_EVENTS.CREATED);
  }

  @OnEvent('work-item.duplicated')
  public async handleWorkItemDuplicated(
    payload?: Record<string, unknown>,
  ): Promise<void> {
    await this.publishWorkItemEvent(payload, WORK_ITEMS_EVENTS.CREATED);
  }

  @OnEvent('work-item.state.changed')
  public async handleWorkItemStateChanged(
    payload?: Record<string, unknown>,
  ): Promise<void> {
    await this.publishWorkItemEvent(payload, WORK_ITEMS_EVENTS.STATE_CHANGED);
  }

  @OnEvent('work-item.updated')
  public async handleWorkItemUpdated(
    payload?: Record<string, unknown>,
  ): Promise<void> {
    await this.publishWorkItemEvent(payload, WORK_ITEMS_EVENTS.UPDATED);
  }

  @OnEvent('work-item.archived')
  public async handleWorkItemArchived(
    payload?: Record<string, unknown>,
  ): Promise<void> {
    await this.publishWorkItemEvent(payload, WORK_ITEMS_EVENTS.UPDATED);
  }

  @OnEvent('work-item.restored')
  public async handleWorkItemRestored(
    payload?: Record<string, unknown>,
  ): Promise<void> {
    await this.publishWorkItemEvent(payload, WORK_ITEMS_EVENTS.UPDATED);
  }

  @OnEvent('work-item.bulk-archived')
  public async handleWorkItemBulkArchived(
    payload?: Record<string, unknown>,
  ): Promise<void> {
    await this.publishWorkItemEvent(payload, WORK_ITEMS_EVENTS.UPDATED);
  }

  @OnEvent('work-item.bulk-restored')
  public async handleWorkItemBulkRestored(
    payload?: Record<string, unknown>,
  ): Promise<void> {
    await this.publishWorkItemEvent(payload, WORK_ITEMS_EVENTS.UPDATED);
  }

  @OnEvent('work-item.deleted')
  public async handleWorkItemDeleted(
    payload?: Record<string, unknown>,
  ): Promise<void> {
    await this.publishWorkItemEvent(payload, WORK_ITEMS_EVENTS.DELETED);
  }

  @OnEvent('state.*')
  public async handleStateUpdated(
    payload?: Record<string, unknown>,
  ): Promise<void> {
    await this.publishWorkItemEvent(payload, WORK_ITEMS_EVENTS.STATE_UPDATED);
  }

  @OnEvent('project.member_removed')
  public async handleMemberRemoved(event: {
    projectId?: string;
    entityId?: string;
    userId?: string;
    targetUserId?: string;
    oldValue?: string;
  }): Promise<void> {
    const projectId = event?.projectId || event?.entityId;
    const userId = event?.userId || event?.targetUserId || event?.oldValue;
    if (!projectId || !userId) {
      return;
    }

    await this.realtimeBus.publish({
      type: 'member:removed',
      projectId,
      userId,
    });
  }

  private async publishWorkItemEvent(
    payload: Record<string, unknown> | undefined,
    event: string,
  ): Promise<void> {
    if (
      !payload ||
      typeof payload.projectId !== 'string' ||
      payload.projectId.length === 0
    ) {
      return;
    }

    await this.realtimeBus.publish({
      type: 'work-item:event',
      projectId: payload.projectId,
      event,
      payload,
    });
  }
}
