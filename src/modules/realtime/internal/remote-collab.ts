import { Injectable } from '@nestjs/common';
import {
  LiveCollaborationPort,
  type LivePresenceUser,
} from '@/modules/pages/core/ports/live-collaboration.port';
import { RealtimeControlClient } from './client';

@Injectable()
export class RemoteLiveCollaborationAdapter extends LiveCollaborationPort {
  constructor(private readonly client: RealtimeControlClient) {
    super();
  }

  public async applyExternalText(
    projectId: string,
    docId: string,
    text: string,
  ): Promise<boolean> {
    return await this.client.applyExternalText(projectId, docId, text);
  }

  public async getPresence(
    projectId: string,
    docId: string | null,
  ): Promise<LivePresenceUser[]> {
    return await this.client.getPresence(projectId, docId);
  }

  public async flushDocs(
    projectId: string,
    docIds: string[],
  ): Promise<string[]> {
    return await this.client.flushDocs(projectId, docIds);
  }

  public async evictDoc(projectId: string, docId: string): Promise<void> {
    await this.client.evictDoc(projectId, docId);
  }
}
