/**
 * modules/manuscripts/core/events/event-bus.service.ts
 *
 * Centralized Domain Event Bus for the Manuscripts Subsystem (DDD Domain Interactions).
 *
 * Decouples tactical domain operations (Docstore mutations, Structure node deletions,
 * History restores, Track Changes resolutions, Git Bridge syncs) from cross-context
 * infrastructure side-effects (Yjs Live Collaboration CRDT sync/eviction, CLSI cache
 * invalidation, and audit telemetry).
 */

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  LIVE_COLLABORATION_PORT,
  LiveCollaborationPort,
  NOOP_LIVE_COLLABORATION,
} from '../ports/live-collaboration.port';

export type PageMutationSource =
  | 'rest-docstore'
  | 'track-changes'
  | 'history-restore'
  | 'git-bridge'
  | 'search-replace'
  | 'citations'
  | 'template-hydration'
  | 'yjs-flush';

export interface PageDocumentMutatedEvent {
  type: 'manuscript.document.mutated';
  projectId: string;
  docId: string;
  lines: string[];
  rev?: number;
  version?: number;
  source: PageMutationSource;
  occurredAt: number;
}

export interface PageNodesDeletedEvent {
  type: 'manuscript.nodes.deleted';
  projectId: string;
  deletedDocIds: string[];
  deletedFileIds: string[];
  hadRootDoc: boolean;
  occurredAt: number;
}

export interface PageHistoryRestoredEvent {
  type: 'manuscript.history.restored';
  projectId: string;
  pageId?: string;
  version?: number;
  snapshotId?: string;
  userId?: string;
  restoredDocIds: string[];
  evictedDocIds?: string[];
  occurredAt: number;
}

export type PageDomainEvent =
  PageDocumentMutatedEvent | PageNodesDeletedEvent | PageHistoryRestoredEvent;

export type PageDomainEventHandler<
  T extends PageDomainEvent = PageDomainEvent,
> = (event: T) => Promise<void> | void;

@Injectable()
export class PageDomainEventBus {
  private readonly logger = new Logger(PageDomainEventBus.name);
  private readonly handlers = new Map<
    PageDomainEvent['type'],
    Set<PageDomainEventHandler<PageDomainEvent>>
  >();
  private readonly liveCollab: LiveCollaborationPort;

  private static isLiveCollabCandidate(
    obj: unknown,
  ): obj is LiveCollaborationPort {
    if (!obj || typeof obj !== 'object') return false;
    const candidate = obj as Partial<LiveCollaborationPort>;
    return (
      typeof candidate.applyExternalText === 'function' ||
      typeof candidate.evictDoc === 'function' ||
      typeof candidate.isNoop === 'boolean'
    );
  }

  constructor(
    @Optional()
    @Inject(LIVE_COLLABORATION_PORT)
    liveCollabOrResolver?:
      | LiveCollaborationPort
      | {
          get?: (
            token: unknown,
            opts?: unknown,
          ) => LiveCollaborationPort | null;
        },
    @Optional()
    @Inject(LIVE_COLLABORATION_PORT)
    secondLiveCollab?: LiveCollaborationPort,
  ) {
    let resolved: LiveCollaborationPort | null | undefined = secondLiveCollab;
    if (!PageDomainEventBus.isLiveCollabCandidate(resolved)) {
      if (PageDomainEventBus.isLiveCollabCandidate(liveCollabOrResolver)) {
        resolved = liveCollabOrResolver;
      } else if (
        liveCollabOrResolver &&
        typeof liveCollabOrResolver.get === 'function'
      ) {
        try {
          resolved = (
            liveCollabOrResolver as {
              get: (
                token: unknown,
                opts?: unknown,
              ) => LiveCollaborationPort | null;
            }
          ).get(LiveCollaborationPort, { strict: false });
        } catch {
          resolved = null;
        }
      }
    }
    this.liveCollab = PageDomainEventBus.isLiveCollabCandidate(resolved)
      ? resolved
      : NOOP_LIVE_COLLABORATION;
    this.registerDefaultCrossContextHandlers();
  }

  private resolveLiveCollaborationPort(): LiveCollaborationPort {
    return this.liveCollab;
  }

  /**
   * Registers default infrastructure handlers for Live Collaboration (Yjs CRDT + Redis)
   * so that any domain mutation or node deletion automatically keeps active Y.Doc sessions
   * and Redis binary snapshots consistent.
   */
  private registerDefaultCrossContextHandlers(): void {
    this.subscribe<PageDocumentMutatedEvent>(
      'manuscript.document.mutated',
      async (event) => {
        if (event.source === 'yjs-flush') return;
        const live = this.resolveLiveCollaborationPort();
        if (typeof live.applyExternalText === 'function') {
          await live.applyExternalText(
            event.projectId,
            event.docId,
            (event.lines || ['']).join('\n'),
          );
        }
      },
    );

    this.subscribe<PageNodesDeletedEvent>(
      'manuscript.nodes.deleted',
      async (event) => {
        if (event.deletedDocIds.length === 0) return;
        const live = this.resolveLiveCollaborationPort();
        if (typeof live.evictDoc === 'function') {
          await Promise.all(
            event.deletedDocIds.map((docId) =>
              live.evictDoc(event.projectId, docId),
            ),
          );
        }
      },
    );

    this.subscribe<PageHistoryRestoredEvent>(
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
        if (typeof live.evictDoc === 'function') {
          await Promise.all(
            docsToEvict.map((docId) => live.evictDoc(event.projectId, docId)),
          );
        }
      },
    );
  }

  public subscribe<T extends PageDomainEvent>(
    eventType: T['type'],
    handler: PageDomainEventHandler<T>,
  ): () => void {
    let set = this.handlers.get(eventType);
    if (!set) {
      set = new Set();
      this.handlers.set(eventType, set);
    }
    const wrappedHandler: PageDomainEventHandler<PageDomainEvent> = (event) =>
      handler(event as T);
    set.add(wrappedHandler);
    return () => {
      set?.delete(wrappedHandler);
    };
  }

  public async publish(event: PageDomainEvent): Promise<void> {
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
