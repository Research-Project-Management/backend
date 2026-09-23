/**
 * modules/manuscripts/docstore/docstore.service.ts
 * Main NestJS Injectable Service orchestrating document store use cases.
 */

import { Injectable, Logger } from '@nestjs/common';
import { IDocRepository } from './core/ports/doc-repository.port';
import { IDocHasher } from './core/ports/doc-hasher.port';
import { GetDocUseCase } from './core/use-cases/get-doc.use-case';
import { PeekDocUseCase, PeekDocResult } from './core/use-cases/peek-doc.use-case';
import { UpdateDocUseCase, UpdateDocResult } from './core/use-cases/update-doc.use-case';
import { PatchDocUseCase } from './core/use-cases/patch-doc.use-case';
import { GetAllDocsUseCase } from './core/use-cases/get-all-docs.use-case';
import { ArchiveProjectUseCase } from './core/use-cases/archive-project.use-case';
import { TextDoc } from './core/domain/text-doc.entity';
import { LineArrayEngine } from './core/adapters/engine/line-array.engine';
import { DocstoreMetrics, DocstoreMetricsSummary } from './core/adapters/telemetry/docstore.metrics';
import { CreateDocDto, UpdateDocDto, PatchDocDto, DocResponseDto } from './dto/doc.dto';
import { WorkspaceFile } from '../clsi/core/ports/workspace.port';

@Injectable()
export class DocstoreService {
  private readonly logger = new Logger(DocstoreService.name);

  constructor(
    private readonly docRepository: IDocRepository,
    private readonly docHasher: IDocHasher,
    private readonly getDocUseCase: GetDocUseCase,
    private readonly peekDocUseCase: PeekDocUseCase,
    private readonly updateDocUseCase: UpdateDocUseCase,
    private readonly patchDocUseCase: PatchDocUseCase,
    private readonly getAllDocsUseCase: GetAllDocsUseCase,
    private readonly archiveProjectUseCase: ArchiveProjectUseCase
  ) {}

  public mapToDto(doc: TextDoc): DocResponseDto {
    return {
      _id: doc.id,
      path: doc.path,
      lines: doc.lines,
      rev: doc.rev,
      version: doc.version,
      ranges: doc.ranges,
      hash: doc.hash,
      sizeBytes: doc.sizeBytes,
      inStorage: doc.inStorage,
      deleted: doc.deleted,
    };
  }

  public async getDoc(
    projectId: string,
    docId: string,
    options?: { includeDeleted?: boolean }
  ): Promise<DocResponseDto> {
    const doc = await this.getDocUseCase.execute(projectId, docId, options);
    return this.mapToDto(doc);
  }

  public async peekDoc(projectId: string, docId: string): Promise<PeekDocResult> {
    return await this.peekDocUseCase.execute(projectId, docId);
  }

  public async getRawDoc(projectId: string, docId: string): Promise<string> {
    const doc = await this.getDocUseCase.execute(projectId, docId);
    return doc.toRawText();
  }

  public async getAllDocs(projectId: string): Promise<DocResponseDto[]> {
    const docs = await this.getAllDocsUseCase.execute(projectId);
    return docs.map((d) => this.mapToDto(d));
  }

  public async getAllDeletedDocs(projectId: string): Promise<DocResponseDto[]> {
    const docs = await this.docRepository.getAllDeletedDocs(projectId);
    return docs.map((d) => this.mapToDto(d));
  }

  public async createDoc(projectId: string, dto: CreateDocDto): Promise<DocResponseDto> {
    const lines = dto.lines || (dto.text ? LineArrayEngine.textToLines(dto.text) : ['']);
    LineArrayEngine.validateLinesSize(lines);

    const hash = this.docHasher.computeHash(lines);
    const doc = await this.docRepository.createDoc({
      projectId,
      path: dto.path,
      lines,
      version: dto.version ?? 0,
      ranges: dto.ranges,
      hash,
    });

    return this.mapToDto(doc);
  }

  public async updateDoc(
    projectId: string,
    docId: string,
    dto: UpdateDocDto
  ): Promise<UpdateDocResult> {
    return await this.updateDocUseCase.execute(
      projectId,
      docId,
      dto.lines,
      dto.version,
      dto.ranges,
      dto.expectedRev
    );
  }

  public async patchDoc(
    projectId: string,
    docId: string,
    dto: PatchDocDto
  ): Promise<DocResponseDto> {
    const doc = await this.patchDocUseCase.execute(projectId, docId, {
      deleted: dto.deleted,
      name: dto.name,
      deletedAt: dto.deletedAt ? new Date(dto.deletedAt) : undefined,
    });
    return this.mapToDto(doc);
  }

  public async archiveDoc(projectId: string, docId: string): Promise<void> {
    await this.archiveProjectUseCase.archiveDoc(projectId, docId);
  }

  public async isDocDeleted(projectId: string, docId: string): Promise<boolean> {
    const doc = await this.getDocUseCase.execute(projectId, docId, { includeDeleted: true });
    return doc.deleted;
  }

  public async getAllRanges(projectId: string): Promise<{ _id: string; ranges: any }[]> {
    const docs = await this.getAllDocsUseCase.execute(projectId);
    return docs.map((d) => ({
      _id: d.id,
      ranges: d.ranges,
    }));
  }

  public async archiveAllDocs(projectId: string): Promise<number> {
    return await this.archiveProjectUseCase.archiveAllDocs(projectId);
  }

  public async unArchiveAllDocs(projectId: string): Promise<number> {
    return await this.archiveProjectUseCase.unarchiveAllDocs(projectId);
  }

  public async destroyAllDocs(projectId: string): Promise<number> {
    return await this.archiveProjectUseCase.destroyAllDocs(projectId);
  }

  /**
   * DIRECT CLSI INTEGRATION: Returns project files ready for compilation.
   */
  public async getAsWorkspaceFiles(projectId: string): Promise<WorkspaceFile[]> {
    return await this.getAllDocsUseCase.executeAsWorkspaceFiles(projectId);
  }

  public getPrometheusMetrics(): string {
    return DocstoreMetrics.toPrometheus();
  }

  public getMetricsSummary(): DocstoreMetricsSummary {
    return DocstoreMetrics.getSummary();
  }
}
