/**
 * modules/manuscripts/core/services/workspace-collector.service.ts
 *
 * Shared service in `manuscripts/core` centralizing live Yjs workspace flushing
 * and document/file workspace collection across `clsi`, `project-history`,
 * `export-import`, and `git-bridge`.
 */

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  LIVE_COLLABORATION_PORT,
  LiveCollaborationPort,
  NOOP_LIVE_COLLABORATION,
} from '../ports/live-collaboration.port';

@Injectable()
export class ProjectWorkspaceCollectorService {
  private readonly logger = new Logger(ProjectWorkspaceCollectorService.name);
  private readonly liveCollab: LiveCollaborationPort;

  constructor(
    @Optional()
    @Inject(LIVE_COLLABORATION_PORT)
    injectedLiveCollab?: LiveCollaborationPort,
  ) {
    this.liveCollab =
      injectedLiveCollab &&
      typeof (injectedLiveCollab as LiveCollaborationPort).flushDocs ===
        'function'
        ? injectedLiveCollab
        : NOOP_LIVE_COLLABORATION;
  }

  /**
   * Resolves the live collaboration port from constructor DI,
   * falling back to `NOOP_LIVE_COLLABORATION` (Null Object Pattern).
   */
  public getLiveCollaborationPort(): LiveCollaborationPort {
    return this.liveCollab;
  }

  /**
   * Flushes active Yjs documents for a project into PostgreSQL/Redis before
   * workspace compilation, snapshot creation, or ZIP export.
   *
   * When `docIds` is omitted or empty, flushes all active Y.Doc sessions in the project.
   */
  public async flushProjectWorkspace(
    projectId: string,
    docIds: string[] = [],
  ): Promise<string[]> {
    const live = this.getLiveCollaborationPort();

    try {
      return await live.flushDocs(projectId, docIds);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Non-blocking live workspace flush warning for project ${projectId}: ${msg}`,
      );
      return [];
    }
  }

  /**
   * Convenience alias to flush explicit docIds.
   */
  public async flushDocs(
    projectId: string,
    docIds: string[],
  ): Promise<string[]> {
    return this.flushProjectWorkspace(projectId, docIds);
  }

  /**
   * Evicts an in-memory Yjs session for a document that was deleted or archived.
   */
  public async evictDoc(projectId: string, docId: string): Promise<void> {
    const live = this.getLiveCollaborationPort();

    try {
      await live.evictDoc(projectId, docId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Non-blocking live workspace evict warning for doc ${projectId}:${docId}: ${msg}`,
      );
    }
  }
}
