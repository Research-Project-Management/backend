/**
 * modules/pages/pages.facade.ts
 *
 * Root Facade providing a unified, high-level programmatic entrypoint into the
 * Pages subsystem (Pure Modular Monolith).
 *
 * Exposes the 5 Core Pillars:
 * 1. Virtual File System & Content Storage (structure + docstore + filestore)
 * 2. CLSI LaTeX Compilation & SyncTeX Engine (clsi)
 * 3. Academic Citations & BibTeX (citations)
 * 4. Project History & Immutable Snapshots (project-history)
 * 5. Packaging, Import & Export (export-import)
 *
 * Decoupled from Realtime: operations run as pure, deterministic requests with
 * safe, non-blocking fallback if live collaboration is inactive.
 */

import { Injectable, Optional } from '@nestjs/common';
import { DocstoreService } from './docstore/docstore.service';
import { UpdateDocDto } from './docstore/dto/doc.dto';
import { StructureService } from './structure/structure.service';
import { FilestoreService } from './filestore/filestore.service';
import { ClsiService } from './clsi/clsi.service';
import { SnapshotService } from './history/services/snapshot.service';
import { RestoreService } from './history/services/restore.service';
import { DiffService } from './history/services/diff.service';
import { CitationsService } from './citations/services/citations.service';
import { ExportService } from './export-import/services/export.service';
import { WorkspaceCollectorService } from './core/services/workspace-collector.service';
import { PageDomainEventBus } from './core/events/event-bus.service';
import { PagesServiceUnavailableError } from '@/modules/pages/core/domain/errors';
import {
  EditorBootstrapService,
  type BootstrapEditorParams,
  type EditorBootstrapResponseDto,
} from './bootstrap';

import {
  CreateNodeDto,
  MoveNodeDto,
  RenameNodeDto,
} from './structure/dto/node.dto';
import { CompilePageDto, ClsiWordCountDto } from './clsi/dto/compile.dto';
import { ForwardSyncDto, ReverseSyncDto } from './clsi/dto/synctex.dto';
import {
  CitationQueryDto,
  ResolveIdentifierDto,
} from './citations/dto/citations.dto';
import { CreateSnapshotDto } from './history/dto/snapshot.dto';
import { ExportZipQueryDto } from './export-import/dto/export.dto';

@Injectable()
export class PagesFacade {
  constructor(
    public readonly docstore: DocstoreService,
    public readonly structure: StructureService,
    public readonly filestore: FilestoreService,
    public readonly clsi: ClsiService,
    public readonly projectHistory: SnapshotService,
    public readonly citations: CitationsService,
    public readonly exportImport: ExportService,
    public readonly workspaceCollector: WorkspaceCollectorService,
    public readonly domainEvents: PageDomainEventBus,
    @Optional() public readonly editorBootstrap?: EditorBootstrapService,
    @Optional() public readonly restoreService?: RestoreService,
    @Optional() public readonly diffService?: DiffService,
  ) {}

  public async bootstrapEditor(
    params: BootstrapEditorParams,
  ): Promise<EditorBootstrapResponseDto> {
    if (!this.editorBootstrap) {
      throw new PagesServiceUnavailableError(
        'EditorBootstrapService is not available',
      );
    }
    return this.editorBootstrap.bootstrapEditor(params);
  }

  // ==========================================================================
  // Pillar 1: Virtual File System & Document Content
  // ==========================================================================

  public async getFileTree(projectId: string) {
    return this.structure.getFileTree(projectId);
  }

  public async getNode(projectId: string, nodeId: string) {
    return this.structure.getNodeById(projectId, nodeId);
  }

  public async getDoc(projectId: string, docId: string) {
    return this.docstore.getDoc(projectId, docId);
  }

  public async updateDocContent(
    projectId: string,
    docId: string,
    dto: UpdateDocDto,
  ) {
    return this.docstore.updateDoc(projectId, docId, dto);
  }

  public async createNode(projectId: string, dto: CreateNodeDto) {
    return this.structure.createNode(projectId, dto);
  }

  public async renameNode(
    projectId: string,
    nodeId: string,
    dto: RenameNodeDto,
  ) {
    return this.structure.renameNode(projectId, nodeId, dto);
  }

  public async moveNode(projectId: string, nodeId: string, dto: MoveNodeDto) {
    return this.structure.moveNode(projectId, nodeId, dto);
  }

  public async deleteNode(projectId: string, nodeId: string): Promise<void> {
    await this.structure.deleteNode(projectId, nodeId);
  }

  // ==========================================================================
  // Pillar 2: CLSI LaTeX Compilation & SyncTeX
  // ==========================================================================

  public async compile(
    dto: CompilePageDto,
    userId: string,
    projectId?: string,
  ) {
    // Optionally flushes any in-flight edits before compiling
    if (projectId) {
      await this.workspaceCollector
        .flushProjectWorkspace(projectId)
        .catch(() => []);
    }
    return this.clsi.compile(dto, userId, projectId);
  }

  public async forwardSync(dto: ForwardSyncDto, projectId?: string) {
    return this.clsi.forwardSync(dto, projectId);
  }

  public async reverseSync(dto: ReverseSyncDto, projectId?: string) {
    return this.clsi.reverseSync(dto, projectId);
  }

  public async getWordCount(dto: ClsiWordCountDto) {
    return this.clsi.getWordCount(dto);
  }

  public cancelCompile(projectId: string): boolean {
    return this.clsi.cancelCompile(projectId);
  }

  // ==========================================================================
  // Pillar 3: Citations & BibTeX
  // ==========================================================================

  public async searchCitationKeys(
    projectId: string,
    queryDto: CitationQueryDto,
  ) {
    return this.citations.listCitations(projectId, queryDto);
  }

  public async resolveAcademicIdentifier(
    projectId: string,
    dto: ResolveIdentifierDto,
  ) {
    return this.citations.resolveIdentifier(projectId, dto);
  }

  // ==========================================================================
  // Pillar 4: Project History & Snapshots
  // ==========================================================================

  public async createSnapshot(
    projectId: string,
    dto: CreateSnapshotDto,
    userId?: string,
  ) {
    return this.projectHistory.createSnapshot(projectId, dto, userId);
  }

  public async listSnapshots(projectId: string) {
    return this.projectHistory.listVersions(projectId);
  }

  public async restoreSnapshot(
    projectId: string,
    targetVersion: number,
    userId?: string,
  ) {
    if (this.restoreService) {
      return this.restoreService.restoreVersion(
        projectId,
        targetVersion,
        userId,
      );
    }
    throw new PagesServiceUnavailableError('RestoreService is not available');
  }

  public async compareSnapshots(
    projectId: string,
    baseVersion: number,
    targetVersion: number,
  ) {
    if (this.diffService) {
      return this.diffService.compareVersions(
        projectId,
        baseVersion,
        targetVersion,
      );
    }
    throw new PagesServiceUnavailableError('DiffService is not available');
  }

  // ==========================================================================
  // Pillar 5: Packaging & Export/Import
  // ==========================================================================

  public async exportProjectZip(projectId: string, query?: ExportZipQueryDto) {
    return this.exportImport.exportProjectZip(projectId, query);
  }
}
