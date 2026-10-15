/**
 * realtime/manuscripts/core/adapters/external/live-collaboration.adapter.ts
 *
 * Driven adapter implementing Docstore's LiveCollaborationPort: keeps REST
 * writes and live Yjs sessions consistent and exposes WebSocket presence.
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  LiveCollaborationPort,
  LivePresenceUser,
} from '@/modules/manuscripts/docstore/domain';
import { YjsDocManagerAdapter } from '../crdt/yjs-doc-manager.adapter';
import { IRoomManagerPort } from '../../ports/room-manager.port';
import { SocketIoBroadcasterAdapter } from '../broadcast/socket-io-broadcaster.adapter';
import { UserPresenceVo } from '../../domain/value-objects/user-presence.vo';

@Injectable()
export class LiveCollaborationAdapter extends LiveCollaborationPort {
  private readonly logger = new Logger(LiveCollaborationAdapter.name);

  constructor(
    private readonly yjs: YjsDocManagerAdapter,
    private readonly rooms: IRoomManagerPort,
    @Optional() private readonly broadcaster?: SocketIoBroadcasterAdapter,
  ) {
    super();
  }

  async applyExternalText(
    projectId: string,
    docId: string,
    text: string,
  ): Promise<boolean> {
    if (!this.yjs.isActive(projectId, docId)) return false;
    const frame = this.yjs.replaceTextIfActive(projectId, docId, text);
    if (frame) {
      const server = this.broadcaster?.getServer() ?? null;
      server?.to(`doc:${projectId}:${docId}`).emit('doc:sync-update', {
        projectId,
        docId,
        data: frame,
      });
      if (!server) {
        this.logger.warn(
          `Live Y.Doc ${projectId}:${docId} updated but socket server unavailable for broadcast`,
        );
      }
    }
    return true;
  }

  async getPresence(
    projectId: string,
    docId: string | null,
  ): Promise<LivePresenceUser[]> {
    const sessions: UserPresenceVo[] = docId
      ? await this.rooms.getDocSessions(projectId, docId)
      : await this.rooms.getProjectSessions(projectId);
    return sessions.map((p) => ({
      id: p.userId,
      userId: p.userId,
      name: p.name,
      color: p.color,
      avatar: p.avatar,
      fileId: p.activeDocId,
      cursor: p.cursor
        ? (p.cursor.toJSON() as unknown as Record<string, unknown>)
        : null,
      lastSeen: p.lastSeenAt.getTime(),
    }));
  }

  async flushDocs(projectId: string, docIds: string[]): Promise<string[]> {
    const flushed: string[] = [];
    for (const docId of docIds) {
      if (!this.yjs.isActive(projectId, docId)) continue;
      await this.yjs.flushDoc(projectId, docId);
      flushed.push(docId);
    }
    return flushed;
  }
}
