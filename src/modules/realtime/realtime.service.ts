/**
 * realtime/realtime.service.ts
 * Main Injectable Service orchestrating Real-Time collaboration and event broadcasting.
 * Exposes clean internal APIs for CLSI, Structure, Docstore, and ProjectHistory subsystems.
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  BroadcastProjectEventUseCase,
  IRoomManagerPort,
  UserPresenceVo,
} from './manuscripts';
import { NotificationGateway } from './notifications/notifications.gateway';

@Injectable()
export class RealtimeService {
  private readonly logger = new Logger(RealtimeService.name);

  constructor(
    private readonly broadcastProjectEventUseCase: BroadcastProjectEventUseCase,
    private readonly roomManager: IRoomManagerPort,
    @Optional() private readonly notificationGateway?: NotificationGateway,
  ) {}

  /**
   * Structure Subsystem Integration:
   * Broadcasts file tree mutations (node created, renamed, moved, deleted) to all active project peers.
   */
  public broadcastFileTreeChange(projectId: string, change: { action: string; node: any }): void {
    this.broadcastProjectEventUseCase.execute({
      projectId,
      event: 'fileTree:update',
      payload: change,
    });
  }

  /**
   * CLSI Subsystem Integration:
   * Broadcasts LaTeX compilation progress, logs, and PDF artifacts to IDE preview clients.
   */
  public broadcastCompileProgress(
    projectId: string,
    progress: { status: 'queued' | 'compiling' | 'success' | 'failed'; logs?: string[]; pdfUrl?: string },
  ): void {
    this.broadcastProjectEventUseCase.execute({
      projectId,
      event: 'compile:progress',
      payload: progress,
    });
  }

  /**
   * Project History Subsystem Integration:
   * Broadcasts new version snapshot creation or label assignment.
   */
  public broadcastSnapshotCreated(
    projectId: string,
    snapshot: { version: number; summary?: string | null; label?: string | null },
  ): void {
    this.broadcastProjectEventUseCase.execute({
      projectId,
      event: 'history:new-version',
      payload: snapshot,
    });
  }

  /**
   * Generic project-wide event dispatch.
   */
  public broadcastEvent(projectId: string, event: string, payload: any): void {
    this.broadcastProjectEventUseCase.execute({
      projectId,
      event,
      payload,
    });
  }

  /**
   * User Notification Dispatch:
   * Sends real-time notification or unread count to a specific user room.
   */
  public notifyUser(userId: string, event: string, payload: any): void {
    if (this.notificationGateway) {
      this.notificationGateway.sendToUser(userId, event, payload);
    }
  }

  /**
   * Global System Broadcast:
   * Emits system-wide alert to all connected sockets.
   */
  public broadcastSystem(event: string, payload: any): void {
    if (this.notificationGateway) {
      this.notificationGateway.broadcastSystem(event, payload);
    }
  }

  /**
   * Queries active collaborator presence in a project.
   */
  public async getProjectPresence(projectId: string): Promise<UserPresenceVo[]> {
    return await this.roomManager.getProjectSessions(projectId);
  }

  /**
   * Queries active collaborator presence in a specific document.
   */
  public async getDocPresence(projectId: string, docId: string): Promise<UserPresenceVo[]> {
    return await this.roomManager.getDocSessions(projectId, docId);
  }
}
