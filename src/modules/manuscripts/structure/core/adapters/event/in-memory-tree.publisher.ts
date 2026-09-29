/**
 * modules/manuscripts/structure/core/adapters/event/in-memory-tree.publisher.ts
 * In-memory tree mutation event publisher (logging + extensible for WebSocket Gateway).
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  ITreePublisher,
  TreeMutationPayload,
} from '../../ports/tree-publisher.port';
import { RealtimeService } from '@/modules/realtime/realtime.service';

@Injectable()
export class InMemoryTreePublisher implements ITreePublisher {
  private readonly logger = new Logger(InMemoryTreePublisher.name);
  private readonly subscribers: ((payload: TreeMutationPayload) => void)[] = [];

  constructor(@Optional() private readonly realtimeService?: RealtimeService) {}

  public async publishTreeMutation(
    payload: TreeMutationPayload,
  ): Promise<void> {
    this.logger.debug(
      `[Tree Mutation] Project ${payload.projectId}: ${payload.action} on ${payload.nodeId} (${payload.path || ''})`,
    );

    // Propagate over WebSocket to all collaborating project peers
    if (this.realtimeService) {
      try {
        this.realtimeService.broadcastFileTreeChange(payload.projectId, {
          action: payload.action,
          node: {
            id: payload.nodeId,
            path: payload.path,
            oldPath: payload.oldPath,
            entityType: payload.entityType,
            data: payload.data,
          },
        });
      } catch (err) {
        this.logger.warn(
          `Failed to broadcast file tree mutation via RealtimeService:`,
          err,
        );
      }
    }

    for (const sub of this.subscribers) {
      try {
        sub(payload);
      } catch (err) {
        this.logger.error(
          `Subscriber threw error handling tree mutation:`,
          err,
        );
      }
    }
  }

  public subscribe(
    handler: (payload: TreeMutationPayload) => void,
  ): () => void {
    this.subscribers.push(handler);
    return () => {
      const idx = this.subscribers.indexOf(handler);
      if (idx !== -1) {
        this.subscribers.splice(idx, 1);
      }
    };
  }
}
