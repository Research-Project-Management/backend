import { Injectable, Logger, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { RoomStore } from './manuscripts/room.store';
import { YjsService } from './manuscripts/yjs.service';
import { ManuscriptsGateway } from './manuscripts/manuscripts.gateway';
import { NotificationGateway } from './notifications/notifications.gateway';
import { CoreService, RealtimeStats } from './core/core.service';
import { UserPresence } from './manuscripts/types/presence.type';
import { REALTIME_EVENTS } from './core/realtime.constant';

@Injectable()
export class RealtimeFacade {
  private readonly logger = new Logger(RealtimeFacade.name);

  constructor(
    private readonly roomStore: RoomStore,
    @Optional() private readonly coreService?: CoreService,
    @Optional() private readonly yjs?: YjsService,
    @Optional() private readonly manuscriptsGateway?: ManuscriptsGateway,
    @Optional() private readonly notificationGateway?: NotificationGateway,
  ) {}

  /**
   * Health and runtime stats for realtime engine.
   */
  public getStats(): RealtimeStats {
    if (this.coreService) {
      return this.coreService.getStats();
    }
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: 0,
    };
  }

  /**
   * Flushes all active Y.Doc documents for a project to storage.
   */
  public async flushProject(projectId: string): Promise<number> {
    if (this.yjs) {
      return await this.yjs.flushProject(projectId);
    }
    return 0;
  }

  /**
   * Pre-Compile Flush Barrier:
   * Synchronously flushes all in-memory Y.Doc sessions for a project to Docstore/Redis before CLSI compile begins.
   */
  public async flushProjectBeforeCompile(projectId: string): Promise<number> {
    return await this.flushProject(projectId);
  }

  /**
   * Structure Subsystem Integration:
   * Broadcasts file tree mutations (node created, renamed, moved, deleted) to all active project peers.
   */
  public broadcastFileTreeChange(
    projectId: string,
    change: { action: string; node: unknown },
  ): void {
    this.broadcastEvent(projectId, REALTIME_EVENTS.FILE_TREE_UPDATE, change);
  }

  /**
   * CLSI Subsystem Integration:
   * Broadcasts LaTeX compilation progress, logs, and PDF artifacts to IDE preview clients.
   */
  public broadcastCompileProgress(
    projectId: string,
    progress: {
      status: 'queued' | 'compiling' | 'success' | 'failed';
      logs?: string[];
      pdfUrl?: string;
    },
  ): void {
    this.broadcastEvent(projectId, REALTIME_EVENTS.COMPILE_PROGRESS, progress);
  }

  /**
   * Project History Subsystem Integration:
   * Broadcasts new version snapshot creation or label assignment.
   */
  public broadcastSnapshotCreated(
    projectId: string,
    snapshot: {
      version: number;
      summary?: string | null;
      label?: string | null;
    },
  ): void {
    this.broadcastEvent(
      projectId,
      REALTIME_EVENTS.HISTORY_NEW_VERSION,
      snapshot,
    );
  }

  /**
   * Generic project-wide event dispatch.
   */
  public broadcastEvent(
    projectId: string,
    event: string,
    payload: unknown,
  ): void {
    if (this.manuscriptsGateway) {
      this.manuscriptsGateway.broadcastToProject(projectId, event, payload);
    }
  }

  /**
   * User Notification Dispatch:
   * Sends real-time notification or unread count to a specific user room.
   */
  public notifyUser(userId: string, event: string, payload: unknown): void {
    if (this.notificationGateway) {
      this.notificationGateway.sendToUser(userId, event, payload);
    }
  }

  /**
   * Global System Broadcast:
   * Emits system-wide alert to all connected sockets.
   */
  public broadcastSystem(event: string, payload: unknown): void {
    if (this.notificationGateway) {
      this.notificationGateway.broadcastSystem(event, payload);
    }
  }

  /**
   * Queries active collaborator presence in a project.
   */
  public async getProjectPresence(projectId: string): Promise<UserPresence[]> {
    return await this.roomStore.getProjectSessions(projectId);
  }

  /**
   * Queries active collaborator presence in a specific document.
   */
  public async getDocPresence(
    projectId: string,
    docId: string,
  ): Promise<UserPresence[]> {
    return await this.roomStore.getDocSessions(projectId, docId);
  }

  /**
   * Decoupled Event Listener: Manuscripts Track Changes & Comments
   */
  @OnEvent('manuscripts.track-changes.event')
  public handleTrackChangesEvent(payload: {
    projectId: string;
    eventName: string;
    data: unknown;
  }): void {
    if (!payload?.projectId || !payload?.eventName) return;
    this.broadcastEvent(payload.projectId, payload.eventName, payload.data);
  }

  /**
   * Decoupled Event Listener: Manuscripts File Tree Changes
   */
  @OnEvent('manuscripts.file-tree.change')
  public handleFileTreeChangeEvent(payload: {
    projectId: string;
    change: { action: string; node: unknown };
  }): void {
    if (!payload?.projectId || !payload?.change) return;
    this.broadcastFileTreeChange(payload.projectId, payload.change);
  }

  /**
   * Decoupled Event Listener: Manuscripts Generic Project Event
   */
  @OnEvent('manuscripts.project.event')
  public handleProjectEvent(payload: {
    projectId: string;
    event: string;
    payload: unknown;
  }): void {
    if (!payload?.projectId || !payload?.event) return;
    this.broadcastEvent(payload.projectId, payload.event, payload.payload);
  }
}
