/**
 * realtime/core/use-cases/broadcast-project-event.use-case.ts
 * Inbound Use Case enabling other subsystems (Structure, CLSI, History) to push live updates to all project peers.
 */

import { Injectable } from '@nestjs/common';
import { IRealtimeBroadcasterPort } from '../ports/realtime-broadcaster.port';

export interface BroadcastProjectEventInput {
  projectId: string;
  event: string;
  payload: any;
  excludeSocketId?: string;
}

@Injectable()
export class BroadcastProjectEventUseCase {
  constructor(private readonly broadcaster: IRealtimeBroadcasterPort) {}

  public execute(input: BroadcastProjectEventInput): void {
    const { projectId, event, payload, excludeSocketId } = input;
    this.broadcaster.broadcastToProject(projectId, event, payload, excludeSocketId);
  }
}
