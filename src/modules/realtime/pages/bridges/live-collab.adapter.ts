import { Injectable, Optional } from '@nestjs/common';
import {
  LiveCollaborationPort,
  LivePresenceUser,
} from '@/modules/pages/core/ports/live-collaboration.port';
import { PAGES_EVENTS, PAGES_ROOMS } from '../pages.constants';
import { YjsService } from '../yjs/yjs.service';
import { RoomPresenceStore } from '../presence/room-presence.store';
import type { ClientSocketData } from '../presence/presence.types';
import { PagesGateway } from '../pages.gateway';

@Injectable()
export class LiveCollaborationAdapter extends LiveCollaborationPort {
  constructor(
    private readonly yjs: YjsService,
    private readonly rooms: RoomPresenceStore,
    @Optional()
    private readonly gateway?: PagesGateway,
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
        .to(PAGES_ROOMS.doc(projectId, docId))
        .emit(PAGES_EVENTS.YJS_SYNC_UPDATE, {
          spaceId: projectId,
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
    if (this.gateway?.server) {
      const room = PAGES_ROOMS.doc(projectId, docId);
      this.gateway.server.to(room).emit(PAGES_EVENTS.DOC_EVICTED, {
        projectId,
        spaceId: projectId,
        docId,
      });
      if (typeof this.gateway.server.in === 'function') {
        try {
          const sockets = await this.gateway.server.in(room).fetchSockets();
          for (const socket of sockets) {
            const socketData = socket.data as ClientSocketData | undefined;
            if (socketData?.activeDocId === docId) {
              socketData.activeDocId = null;
            }
            socket.leave(room);
            await this.rooms
              .leaveDocRoom(projectId, docId, socket.id)
              .catch(() => {});
          }
        } catch {
          // Best effort room kick
        }
      }
    }
    await this.yjs.evictDoc(projectId, docId, { skipFlush: true });
  }
}
