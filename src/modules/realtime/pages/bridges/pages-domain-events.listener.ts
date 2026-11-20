import { Injectable, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { PAGES_EVENTS } from '../pages.constants';
import { PagesGateway } from '../pages.gateway';

@Injectable()
export class PagesDomainEventsListener {
  constructor(@Optional() private readonly pagesGateway?: PagesGateway) {}

  @OnEvent('manuscripts.track-changes.event')
  public handleTrackChangesEvent(payload: {
    projectId: string;
    eventName: string;
    data: unknown;
  }): void {
    if (!payload?.projectId || !payload?.eventName) return;
    this.pagesGateway?.broadcastToProject(
      payload.projectId,
      payload.eventName,
      payload.data,
    );
  }

  @OnEvent('manuscripts.file-tree.change')
  public handleFileTreeChangeEvent(payload: {
    projectId: string;
    change: { action: string; node: unknown };
  }): void {
    if (!payload?.projectId || !payload?.change) return;
    this.pagesGateway?.broadcastToProject(
      payload.projectId,
      PAGES_EVENTS.FILE_TREE_UPDATE,
      payload.change,
    );
  }

  @OnEvent('manuscripts.project.event')
  public handleProjectEvent(payload: {
    projectId: string;
    event: string;
    payload: unknown;
  }): void {
    if (!payload?.projectId || !payload?.event) return;
    this.pagesGateway?.broadcastToProject(
      payload.projectId,
      payload.event,
      payload.payload,
    );
  }
}
