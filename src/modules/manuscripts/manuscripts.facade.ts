/**
 * modules/manuscripts/manuscripts.facade.ts
 *
 * Root Facade providing a unified, high-level programmatic entrypoint into the
 * Manuscripts subsystem (Pure Modular Monolith).
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
import { ClsiService } from './clsi/services/clsi.service';
import { ProjectHistoryService } from './project-history/project-history.service';
import { CitationsService } from './citations/citations.service';
import { ExportImportService } from './export-import/export-import.service';
import { ProjectWorkspaceCollectorService } from './core/services/project-workspace-collector.service';
import { ManuscriptDomainEventBus } from './core/events/manuscript-domain-event-bus.service';

import { CreateNodeDto, MoveNodeDto, RenameNodeDto } from './structure/dto/node.dto';
import { CompileManuscriptDto, ClsiWordCountDto } from './clsi/dto/clsi.dto';
import { ForwardSyncDto, ReverseSyncDto } from './clsi/dto/synctex.dto';
import { CitationQueryDto, ResolveIdentifierDto } from './citations/dto/citations.dto';
import { CreateSnapshotDto } from './project-history/dto/history.dto';
import { ExportZipQueryDto } from './export-import/dto/export-import.dto';

@Injectable()
export class ManuscriptsFacade {
  constructor(
    public readonly docstore: DocstoreService,
    public readonly structure: StructureService,
    public readonly filestore: FilestoreService,
    public readonly clsi: ClsiService,
    public readonly projectHistory: ProjectHistoryService,
    public readonly citations: CitationsService,
    public readonly exportImport: ExportImportService,
    public readonly workspaceCollector: ProjectWorkspaceCollectorService,
    public readonly domainEvents: ManuscriptDomainEventBus,
  ) {}

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

  public async moveNode(
    projectId: string,
    nodeId: string,
    dto: MoveNodeDto,
  ) {
    return this.structure.moveNode(projectId, nodeId, dto);
  }

  public async deleteNode(projectId: string, nodeId: string): Promise<void> {
    await this.structure.deleteNode(projectId, nodeId).catch(() => null);
    await this.docstore.deleteDoc?.(projectId, nodeId).catch(() => null);
    await this.workspaceCollector.evictDoc(projectId, nodeId).catch(() => null);
  }

  // ==========================================================================
  // Pillar 2: CLSI LaTeX Compilation & SyncTeX
  // ==========================================================================

  public async compile(
    dto: CompileManuscriptDto,
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
    return this.citations.searchCitationKeys(projectId, queryDto);
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
    return this.projectHistory.restoreVersion(projectId, targetVersion, userId);
  }

  public async compareSnapshots(
    projectId: string,
    baseVersion: number,
    targetVersion: number,
  ) {
    return this.projectHistory.compareVersions(projectId, baseVersion, targetVersion);
  }

  // ==========================================================================
  // Pillar 5: Packaging & Export/Import
  // ==========================================================================

  public async exportProjectZip(
    projectId: string,
    query?: ExportZipQueryDto,
  ) {
    return this.exportImport.exportProjectZip(projectId, query);
  }
}
