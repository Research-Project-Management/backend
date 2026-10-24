/**
 * modules/manuscripts/core/services/project-workspace-collector.service.ts
 *
 * Shared service in `manuscripts/core` centralizing live Yjs workspace flushing
 * and document/file workspace collection across `clsi`, `project-history`,
 * `export-import`, and `git-bridge`.
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { LiveCollaborationPort } from '../ports/live-collaboration.port';

@Injectable()
export class ProjectWorkspaceCollectorService {
  private readonly logger = new Logger(ProjectWorkspaceCollectorService.name);

  constructor(@Optional() private readonly moduleRef?: ModuleRef) {}

  /**
   * Resolves the live collaboration port from the DI container when available.
   */
  public getLiveCollaborationPort(): LiveCollaborationPort | null {
    try {
      return (
        this.moduleRef?.get(LiveCollaborationPort, { strict: false }) ?? null
      );
    } catch {
      return null;
    }
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
    if (!live) return [];

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
    if (!live) return;

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
