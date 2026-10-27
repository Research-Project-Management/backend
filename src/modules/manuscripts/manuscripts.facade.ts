/**
 * modules/manuscripts/manuscripts.facade.ts
 * Root Facade providing a unified programmatic entrypoint into the Manuscripts subsystem.
 * Follows Matt Pocock Codebase Design (Deep Module) with high-level orchestration methods.
 */

import { Injectable } from '@nestjs/common';
import { DocstoreService } from './docstore/docstore.service';
import { StructureService } from './structure/structure.service';
import { FilestoreService } from './filestore/filestore.service';
import { ClsiService } from './clsi/services/clsi.service';
import { ProjectHistoryService } from './project-history/project-history.service';
import { TrackChangesService } from './track-changes/track-changes.service';
import { CitationsService } from './citations/citations.service';
import { ProjectWorkspaceCollectorService } from './core/services/project-workspace-collector.service';
import { ManuscriptDomainEventBus } from './core/events/manuscript-domain-event-bus.service';

@Injectable()
export class ManuscriptsFacade {
  constructor(
    public readonly docstore: DocstoreService,
    public readonly structure: StructureService,
    public readonly filestore: FilestoreService,
    public readonly clsi: ClsiService,
    public readonly projectHistory: ProjectHistoryService,
    public readonly trackChanges: TrackChangesService,
    public readonly citations: CitationsService,
    public readonly workspaceCollector: ProjectWorkspaceCollectorService,
    public readonly domainEvents: ManuscriptDomainEventBus,
  ) {}

  /**
   * Flushes any in-flight live Yjs edits for the specified document or all documents
   * in the project down to Postgres before performing operations like compile or export.
   */
  public async prepareProjectWorkspace(
    projectId: string,
    docIds?: string[],
  ): Promise<string[]> {
    return this.workspaceCollector.flushProjectWorkspace(
      projectId,
      docIds ?? [],
    );
  }

  /**
   * Safely deletes a document from structure, docstore, and any active live collaboration session.
   */
  public async removeDocument(projectId: string, docId: string): Promise<void> {
    await this.structure.deleteNode(projectId, docId).catch(() => null);
    await this.docstore.deleteDoc?.(projectId, docId).catch(() => null);
    await this.workspaceCollector.evictDoc(projectId, docId);
  }
}
