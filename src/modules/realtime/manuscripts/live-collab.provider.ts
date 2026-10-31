import {
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import {
  LiveCollaborationPort,
  LivePresenceUser,
} from '@/modules/manuscripts/core';
import { YjsService } from './yjs.service';
import { RoomStore } from './room.store';
import { ManuscriptsGateway } from './manuscripts.gateway';
import { REALTIME_EVENTS } from '../core/realtime.constant';

@Injectable()
export class LiveCollaborationProvider extends LiveCollaborationPort {
  private readonly logger = new Logger(LiveCollaborationProvider.name);

  constructor(
    private readonly yjs: YjsService,
    private readonly rooms: RoomStore,
    @Optional()
    private readonly gateway?: ManuscriptsGateway,
  ) {
    super();
  }

  async applyExternalText(
    projectId: string,
    docId: string,
    text: string,
  ): Promise<boolean> {
    const { active, frame } = await this.yjs.applyExternalTextAndSyncRedis(
      projectId,
      docId,
      text,
    );
    if (!active) return false;
    if (frame && this.gateway?.server) {
      this.gateway.server
        .to(`doc:${projectId}:${docId}`)
        .emit(REALTIME_EVENTS.YJS_SYNC_UPDATE, {
          projectId,
          docId,
          data: frame,
        });
    }
    return true;
  }

  async getPresence(
    projectId: string,
    docId: string | null,
  ): Promise<LivePresenceUser[]> {
    const sessions = docId
      ? await this.rooms.getDocSessions(projectId, docId)
      : await this.rooms.getProjectSessions(projectId);

    return sessions.map((p) => ({
      id: p.userId,
      userId: p.userId,
      name: p.name ?? 'Collaborator',
      color: p.color ?? '#3B82F6',
      avatar: p.avatar ?? null,
      fileId: p.activeDocId ?? null,
      cursor: p.cursor as unknown as Record<string, unknown> | null,
      lastSeen: p.lastHeartbeat,
    }));
  }

  async flushDocs(projectId: string, docIds: string[]): Promise<string[]> {
    if (!docIds || docIds.length === 0) {
      return await this.yjs.flushProjectDocs(projectId);
    }

    const flushed = new Set<string>();
    for (const docId of docIds) {
      if (this.yjs.isActive(projectId, docId)) {
        await this.yjs.flushDoc(projectId, docId);
        flushed.add(docId);
      }
    }
    return Array.from(flushed);
  }

  async evictDoc(projectId: string, docId: string): Promise<void> {
    await this.yjs.evictDoc(projectId, docId, { skipFlush: true });
  }
}
