/**
 * modules/pages/core/services/workspace-collector.service.ts
 *
 * Shared service in `pages/core` centralizing live Yjs workspace flushing
 * and document session eviction across `clsi`, `export-import`, and `page` cleanup.
 */

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  LIVE_COLLABORATION_PORT,
  LiveCollaborationPort,
  NOOP_LIVE_COLLABORATION,
} from '../ports/live-collaboration.port';

export interface WorkspaceFlushOptions {
  /**
   * When true, rethrows live flush failures instead of degrading to a logged warning
   * so callers that require strict read-your-writes guarantees can fail closed.
   */
  strict?: boolean;
}

@Injectable()
export class WorkspaceCollectorService {
  private readonly logger = new Logger(WorkspaceCollectorService.name);
  private readonly liveCollab: LiveCollaborationPort;

  constructor(
    @Optional()
    @Inject(LIVE_COLLABORATION_PORT)
    injectedLiveCollab?: LiveCollaborationPort,
  ) {
    this.liveCollab =
      injectedLiveCollab && typeof injectedLiveCollab.flushDocs === 'function'
        ? injectedLiveCollab
        : NOOP_LIVE_COLLABORATION;
  }

  /**
   * Flushes active Yjs documents for a space into PostgreSQL/Redis before
   * workspace compilation, snapshot creation, or ZIP export.
   *
   * When `docIds` is omitted or empty, flushes all active Y.Doc sessions in the space.
   */
  public async flushProjectWorkspace(
    spaceId: string,
    docIds: string[] = [],
    options?: WorkspaceFlushOptions,
  ): Promise<string[]> {
    try {
      return await this.liveCollab.flushDocs(spaceId, docIds);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      const scopeDesc =
        docIds.length > 0 ? `${docIds.length} doc(s)` : 'all active docs';
      if (options?.strict) {
        this.logger.error(
          `Strict live workspace flush failed for space ${spaceId} (${scopeDesc}): ${msg}`,
          stack,
        );
        throw err;
      }
      this.logger.warn(
        `Live workspace flush degraded for space ${spaceId} (${scopeDesc}) — falling back to persisted DB state: ${msg}`,
        stack,
      );
      return [];
    }
  }

  /**
   * Flushes explicit `docIds` in `spaceId` to persistent storage.
   */
  public async flushDocs(
    spaceId: string,
    docIds: string[],
    options?: WorkspaceFlushOptions,
  ): Promise<string[]> {
    return this.flushProjectWorkspace(spaceId, docIds, options);
  }

  /**
   * Evicts an in-memory Yjs session for a document that was deleted or archived.
   */
  public async evictDoc(
    spaceId: string,
    docId: string,
    options?: WorkspaceFlushOptions,
  ): Promise<void> {
    try {
      await this.liveCollab.evictDoc(spaceId, docId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      if (options?.strict) {
        this.logger.error(
          `Strict live workspace evict failed for doc ${spaceId}:${docId}: ${msg}`,
          stack,
        );
        throw err;
      }
      this.logger.warn(
        `Live workspace evict warning for doc ${spaceId}:${docId}: ${msg}`,
        stack,
      );
    }
  }
}
