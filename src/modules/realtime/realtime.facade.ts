import { Injectable, Optional } from '@nestjs/common';
import type { LivePresenceUser } from '@/modules/pages/core/ports/live-collaboration.port';
import { PAGES_EVENTS } from './channels/pages/config';
import { PagesGateway } from './channels/pages/gateway';
import { RoomPresenceStore } from './channels/pages/presence';
import { YjsService } from './channels/pages/yjs/engine';
import type { CursorPosition, UserPresence } from './channels/pages/types';
import {
  RealtimeEventBus,
  type ChatReactionBroadcastPayload,
} from './core/bus';
import { RealtimeControlClient } from './internal/client';

export interface RealtimeStats {
  status: 'ok' | 'degraded';
  timestamp: string;
  uptime: number;
}

@Injectable()
export class RealtimeFacade {
  private readonly startTime = Date.now();

  constructor(
    @Optional() private readonly roomStore?: RoomPresenceStore,
    @Optional() private readonly yjs?: YjsService,
    @Optional() private readonly pagesGateway?: PagesGateway,
    @Optional() private readonly realtimeBus?: RealtimeEventBus,
    @Optional() private readonly controlClient?: RealtimeControlClient,
  ) {}

  public getStats(): RealtimeStats {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
    };
  }

  public async flushProject(projectId: string): Promise<number> {
    if (this.yjs) {
      return await this.yjs.flushProject(projectId);
    }
    if (this.controlClient) {
      const flushed = await this.controlClient.flushDocs(projectId, []);
      return flushed.length;
    }
    return 0;
  }

  public async flushProjectBeforeCompile(projectId: string): Promise<number> {
    return await this.flushProject(projectId);
  }

  public broadcastFileTreeChange(
    projectId: string,
    change: { action: string; node: unknown },
  ): void {
    this.broadcastEvent(projectId, PAGES_EVENTS.FILE_TREE_UPDATE, change);
  }

  public broadcastCompileProgress(
    projectId: string,
    progress: {
      status: 'queued' | 'compiling' | 'success' | 'failed';
      logs?: string[];
      pdfUrl?: string;
      summary?: {
        totalErrors: number;
        totalWarnings: number;
        totalBadboxes: number;
      };
      logArtifactUrl?: string;
    },
  ): void {
    this.broadcastEvent(projectId, PAGES_EVENTS.COMPILE_PROGRESS, progress);
  }

  public broadcastSnapshotCreated(
    projectId: string,
    snapshot: {
      version: number;
      summary?: string | null;
      label?: string | null;
    },
  ): void {
    this.broadcastEvent(projectId, PAGES_EVENTS.HISTORY_NEW_VERSION, snapshot);
  }

  public broadcastEvent(
    projectId: string,
    event: string,
    payload: unknown,
  ): void {
    if (this.pagesGateway) {
      this.pagesGateway.broadcastToProject(projectId, event, payload);
      return;
    }

    void this.realtimeBus?.publish({
      type: 'pages:project-event',
      projectId,
      event,
      payload,
    });
  }

  public async getProjectPresence(projectId: string): Promise<UserPresence[]> {
    if (this.roomStore) {
      return await this.roomStore.getProjectSessions(projectId);
    }
    if (this.controlClient) {
      const users = await this.controlClient.getPresence(projectId, null);
      return users.map((u) => this.toUserPresence(projectId, u));
    }
    return [];
  }

  public async getDocPresence(
    projectId: string,
    docId: string,
  ): Promise<UserPresence[]> {
    if (this.roomStore) {
      return await this.roomStore.getDocSessions(projectId, docId);
    }
    if (this.controlClient) {
      const users = await this.controlClient.getPresence(projectId, docId);
      return users.map((u) => this.toUserPresence(projectId, u));
    }
    return [];
  }

  private toUserPresence(
    projectId: string,
    user: LivePresenceUser,
  ): UserPresence {
    return {
      userId: user.userId,
      socketId: user.id,
      spaceId: projectId,
      name: user.name,
      color: user.color,
      avatar: user.avatar,
      activeDocId: user.fileId,
      cursor: user.cursor as CursorPosition | null,
      lastHeartbeat: user.lastSeen,
    };
  }

  public async publishChatMessage(
    conversationId: string,
    message: unknown,
    memberIds?: string[],
  ): Promise<void> {
    await this.realtimeBus?.publish({
      type: 'chat:message',
      conversationId,
      message,
      memberIds,
    });
  }

  public async publishChatReaction(
    conversationId: string,
    payload: ChatReactionBroadcastPayload,
  ): Promise<void> {
    await this.realtimeBus?.publish({
      type: 'chat:reaction',
      conversationId,
      payload,
    });
  }

  public async publishWorkItemEvent(
    projectId: string,
    event: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.realtimeBus?.publish({
      type: 'work-item:event',
      projectId,
      event,
      payload,
    });
  }

  public async publishMemberRemoved(
    projectId: string,
    userId: string,
  ): Promise<void> {
    await this.realtimeBus?.publish({
      type: 'member:removed',
      projectId,
      userId,
    });
  }
}
