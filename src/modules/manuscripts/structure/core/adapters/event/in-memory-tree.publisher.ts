/**
 * modules/manuscripts/structure/core/adapters/event/in-memory-tree.publisher.ts
 * In-memory tree mutation event publisher (logging + extensible for WebSocket Gateway).
 */

import { Injectable, Logger } from '@nestjs/common';
import { ITreePublisher, TreeMutationPayload } from '../../ports/tree-publisher.port';

@Injectable()
export class InMemoryTreePublisher implements ITreePublisher {
  private readonly logger = new Logger(InMemoryTreePublisher.name);
  private readonly subscribers: ((payload: TreeMutationPayload) => void)[] = [];

  public async publishTreeMutation(payload: TreeMutationPayload): Promise<void> {
    this.logger.debug(
      `[Tree Mutation] Project ${payload.projectId}: ${payload.action} on ${payload.nodeId} (${payload.path || ''})`
    );

    for (const sub of this.subscribers) {
      try {
        sub(payload);
      } catch (err) {
        this.logger.error(`Subscriber threw error handling tree mutation:`, err);
      }
    }
  }

  public subscribe(handler: (payload: TreeMutationPayload) => void): () => void {
    this.subscribers.push(handler);
    return () => {
      const idx = this.subscribers.indexOf(handler);
      if (idx !== -1) {
        this.subscribers.splice(idx, 1);
      }
    };
  }
}
