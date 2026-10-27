/**
 * modules/manuscripts/core/events/manuscript-domain-event-bus.service.ts
 *
 * Centralized Domain Event Bus for the Manuscripts Subsystem (DDD Domain Interactions).
 *
 * Decouples tactical domain operations (Docstore mutations, Structure node deletions,
 * History restores, Track Changes resolutions, Git Bridge syncs) from cross-context
 * infrastructure side-effects (Yjs Live Collaboration CRDT sync/eviction, CLSI cache
 * invalidation, and audit telemetry).
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import {
  LiveCollaborationPort,
  NOOP_LIVE_COLLABORATION,
} from '../ports/live-collaboration.port';

export type ManuscriptMutationSource =
  | 'rest-docstore'
  | 'track-changes'
  | 'history-restore'
  | 'git-bridge'
  | 'search-replace'
  | 'citations'
  | 'linked-files'
  | 'template-hydration'
  | 'yjs-flush';

export interface ManuscriptDocumentMutatedEvent {
  type: 'manuscript.document.mutated';
  projectId: string;
  docId: string;
  lines: string[];
  rev?: number;
  version?: number;
  source: ManuscriptMutationSource;
  occurredAt: number;
}

export interface ManuscriptNodesDeletedEvent {
  type: 'manuscript.nodes.deleted';
  projectId: string;
  deletedDocIds: string[];
  deletedFileIds: string[];
  hadRootDoc: boolean;
  occurredAt: number;
}

export interface ManuscriptHistoryRestoredEvent {
  type: 'manuscript.history.restored';
  projectId: string;
  version?: number;
  snapshotId?: string;
  userId?: string;
  restoredDocIds: string[];
  evictedDocIds?: string[];
  occurredAt: number;
}

export type ManuscriptDomainEvent =
  | ManuscriptDocumentMutatedEvent
  | ManuscriptNodesDeletedEvent
  | ManuscriptHistoryRestoredEvent;

export type ManuscriptDomainEventHandler<
  T extends ManuscriptDomainEvent = ManuscriptDomainEvent,
> = (event: T) => Promise<void> | void;

@Injectable()
export class ManuscriptDomainEventBus {
  private readonly logger = new Logger(ManuscriptDomainEventBus.name);
  private readonly handlers = new Map<
    ManuscriptDomainEvent['type'],
    Set<ManuscriptDomainEventHandler<any>>
  >();

  constructor(
    @Optional() private readonly moduleRef?: ModuleRef,
    @Optional() private readonly injectedLiveCollab?: LiveCollaborationPort,
  ) {
    this.registerDefaultCrossContextHandlers();
  }

  private resolveLiveCollaborationPort(): LiveCollaborationPort {
    if (this.injectedLiveCollab) {
      return this.injectedLiveCollab;
    }
    try {
      return (
        this.moduleRef?.get(LiveCollaborationPort, { strict: false }) ??
        NOOP_LIVE_COLLABORATION
      );
    } catch {
      return NOOP_LIVE_COLLABORATION;
    }
  }

  /**
   * Registers default infrastructure handlers for Live Collaboration (Yjs CRDT + Redis)
   * so that any domain mutation or node deletion automatically keeps active Y.Doc sessions
   * and Redis binary snapshots consistent.
   */
  private registerDefaultCrossContextHandlers(): void {
    this.subscribe<ManuscriptDocumentMutatedEvent>(
      'manuscript.document.mutated',
      async (event) => {
        if (event.source === 'yjs-flush') return;
        const live = this.resolveLiveCollaborationPort();
        await live.applyExternalText(
          event.projectId,
          event.docId,
          (event.lines || ['']).join('\n'),
        );
      },
    );

    this.subscribe<ManuscriptNodesDeletedEvent>(
      'manuscript.nodes.deleted',
      async (event) => {
        if (event.deletedDocIds.length === 0) return;
        const live = this.resolveLiveCollaborationPort();
        await Promise.all(
          event.deletedDocIds.map((docId) =>
            live.evictDoc(event.projectId, docId),
          ),
        );
      },
    );

    this.subscribe<ManuscriptHistoryRestoredEvent>(
      'manuscript.history.restored',
      async (event) => {
        this.logger.debug(
          `Processed manuscript.history.restored for project ${event.projectId} (v${event.version ?? event.snapshotId}, ${event.restoredDocIds.length} docs)`,
        );
        // Only evict documents explicitly marked in `evictedDocIds` (e.g., docs removed by snapshot restore
        // that were not already updated in-place via `manuscript.document.mutated` -> `applyExternalText`).
        const docsToEvict = event.evictedDocIds ?? [];
        if (docsToEvict.length === 0) return;
        const live = this.resolveLiveCollaborationPort();
        await Promise.all(
          docsToEvict.map((docId) => live.evictDoc(event.projectId, docId)),
        );
      },
    );
  }

  public subscribe<T extends ManuscriptDomainEvent>(
    eventType: T['type'],
    handler: ManuscriptDomainEventHandler<T>,
  ): () => void {
    let set = this.handlers.get(eventType);
    if (!set) {
      set = new Set();
      this.handlers.set(eventType, set);
    }
    set.add(handler);
    return () => {
      set?.delete(handler);
    };
  }

  public async publish(event: ManuscriptDomainEvent): Promise<void> {
    const subscribers = this.handlers.get(event.type);
    if (!subscribers || subscribers.size === 0) return;

    for (const handler of subscribers) {
      try {
        await handler(event);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `Domain event handler warning on '${event.type}' for project ${event.projectId}: ${msg}`,
        );
      }
    }
  }
}
