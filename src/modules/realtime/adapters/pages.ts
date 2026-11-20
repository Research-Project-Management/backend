import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { PAGES_DOMAIN_EVENTS, PAGES_EVENTS } from '../channels/pages/config';
import { RealtimeEventBus } from '../core/bus';

export interface MemberUpdatedEventPayload {
  projectId?: string;
  userId?: string;
  role?: string;
  newRole?: string;
  entityId?: string;
  newValue?: string;
  targetUserId?: string;
  metadata?: { targetId?: string; oldRole?: string; newRole?: string };
}

@Injectable()
export class PagesEventsPublisher {
  constructor(private readonly realtimeBus: RealtimeEventBus) {}

  @OnEvent(PAGES_DOMAIN_EVENTS.FILE_TREE_CHANGE)
  public async handleFileTreeChangeEvent(payload?: {
    projectId?: string;
    change?: { action: string; node: unknown };
  }): Promise<void> {
    if (!payload?.projectId || !payload?.change) {
      return;
    }

    await this.realtimeBus.publish({
      type: 'pages:project-event',
      projectId: payload.projectId,
      event: PAGES_EVENTS.FILE_TREE_UPDATE,
      payload: payload.change,
    });
  }

  @OnEvent(PAGES_DOMAIN_EVENTS.PROJECT_EVENT)
  public async handleProjectEvent(payload?: {
    projectId?: string;
    event?: string;
    payload?: unknown;
  }): Promise<void> {
    if (!payload?.projectId || !payload?.event) {
      return;
    }

    await this.realtimeBus.publish({
      type: 'pages:project-event',
      projectId: payload.projectId,
      event: payload.event,
      payload: payload.payload,
    });
  }

  @OnEvent('project.member_updated')
  public async handleMemberUpdated(
    event?: MemberUpdatedEventPayload,
  ): Promise<void> {
    if (!event) {
      return;
    }

    const projectId = event.projectId || event.entityId;
    const userId =
      event.userId || event.targetUserId || event.metadata?.targetId;
    const role =
      event.newRole || event.role || event.metadata?.newRole || event.newValue;

    if (!projectId || !userId) {
      return;
    }

    await this.realtimeBus.publish({
      type: 'member:updated',
      projectId,
      userId,
      ...(role ? { role } : {}),
    });
  }

  @OnEvent('project.ownership_transferred')
  public async handleOwnershipTransferred(event?: {
    projectId?: string;
    previousOwnerId?: string;
    newOwnerId?: string;
  }): Promise<void> {
    if (!event?.projectId) {
      return;
    }

    await this.realtimeBus.publish({
      type: 'ownership:transferred',
      projectId: event.projectId,
      previousOwnerId: event.previousOwnerId,
      newOwnerId: event.newOwnerId,
    });
  }

  @OnEvent('project.deleted')
  public async handleProjectDeleted(event?: {
    projectId?: string;
    entityId?: string;
  }): Promise<void> {
    const projectId = event?.projectId || event?.entityId;
    if (!projectId) {
      return;
    }

    await this.realtimeBus.publish({
      type: 'project:deleted',
      projectId,
    });
  }
}
