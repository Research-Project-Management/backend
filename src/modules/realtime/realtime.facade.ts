import { Injectable, Optional } from '@nestjs/common';
import {
  RealtimeHealthService,
  RealtimeStats,
} from './core/realtime-health.service';
import { PAGES_EVENTS } from './pages/pages.constants';
import { PagesGateway } from './pages/pages.gateway';
import { RoomPresenceStore } from './pages/presence/room-presence.store';
import { UserPresence } from './pages/presence/presence.types';
import { YjsService } from './pages/yjs/yjs.service';

@Injectable()
export class RealtimeFacade {
  constructor(
    private readonly roomStore: RoomPresenceStore,
    @Optional() private readonly healthService?: RealtimeHealthService,
    @Optional() private readonly yjs?: YjsService,
    @Optional() private readonly pagesGateway?: PagesGateway,
  ) {}

  public getStats(): RealtimeStats {
    if (this.healthService) {
      return this.healthService.getStats();
    }
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: 0,
    };
  }

  public async flushProject(projectId: string): Promise<number> {
    if (this.yjs) {
      return await this.yjs.flushProject(projectId);
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
    this.pagesGateway?.broadcastToProject(projectId, event, payload);
  }

  public async getProjectPresence(projectId: string): Promise<UserPresence[]> {
    return await this.roomStore.getProjectSessions(projectId);
  }

  public async getDocPresence(
    projectId: string,
    docId: string,
  ): Promise<UserPresence[]> {
    return await this.roomStore.getDocSessions(projectId, docId);
  }
}
