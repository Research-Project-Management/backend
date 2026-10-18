import { Injectable, Logger, Optional, forwardRef, Inject } from '@nestjs/common';
import {
  LiveCollaborationPort,
  LivePresenceUser,
} from '@/modules/manuscripts/docstore/domain';
import { YjsService } from './yjs.service';
import { RoomStore } from './room.store';
import { ManuscriptsGateway } from './manuscripts.gateway';

@Injectable()
export class LiveCollaborationProvider extends LiveCollaborationPort {
  private readonly logger = new Logger(LiveCollaborationProvider.name);

  constructor(
    private readonly yjs: YjsService,
    private readonly rooms: RoomStore,
    @Optional() @Inject(forwardRef(() => ManuscriptsGateway))
    private readonly gateway?: ManuscriptsGateway,
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
    if (frame && this.gateway?.server) {
      this.gateway.server.to(`doc:${projectId}:${docId}`).emit('doc:sync-update', {
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
    const flushed: string[] = [];
    for (const docId of docIds) {
      if (!this.yjs.isActive(projectId, docId)) continue;
      await this.yjs.flushDoc(projectId, docId);
      flushed.push(docId);
    }
    return flushed;
  }
}
