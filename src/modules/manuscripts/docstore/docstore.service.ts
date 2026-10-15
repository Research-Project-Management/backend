/**
 * modules/manuscripts/docstore/docstore.service.ts
 * Deep Module Service orchestrating document store persistence, SHA-256 hashing,
 * cold-tier S3 archive/unarchive, track-change line mutations, and LaTeX export transpilation.
 */

import { Injectable, Logger, Optional, Inject } from '@nestjs/common';
import { IDocRepository } from './core/ports/doc-repository.port';
import { IDocPersistor } from './core/ports/doc-persistor.port';
import { IDocHasher } from './core/ports/doc-hasher.port';
import { GetDocUseCase } from './core/use-cases/get-doc.use-case';
import {
  PeekDocUseCase,
  PeekDocResult,
} from './core/use-cases/peek-doc.use-case';
import {
  UpdateDocUseCase,
  UpdateDocResult,
} from './core/use-cases/update-doc.use-case';
import { PatchDocUseCase } from './core/use-cases/patch-doc.use-case';
import { GetAllDocsUseCase } from './core/use-cases/get-all-docs.use-case';
import { ArchiveProjectUseCase } from './core/use-cases/archive-project.use-case';
import { TextDoc } from './core/domain/text-doc.entity';
import { DocRanges } from './core/domain/doc-range.vo';
import { LineArrayEngine } from './core/adapters/engine/line-array.engine';
import {
  DocstoreMetrics,
  DocstoreMetricsSummary,
} from './core/adapters/telemetry/docstore.metrics';
import {
  CreateDocDto,
  UpdateDocDto,
  PatchDocDto,
  DocResponseDto,
} from './dto/doc.dto';
import { WorkspaceFile } from '@/modules/manuscripts/clsi/domain';
import { computeDocSha256 } from './domain/doc-hasher';
import {
  TrackChangeSuggestionSpec,
  applySuggestionToLines,
  applyBatchSuggestionsToLines,
} from './domain/text-suggestion-mutator';
import {
  IncludedProjectDoc,
  resolveIncludedLatexContent,
  convertLatexToMarkdown,
  convertLatexToHtml,
  convertLatexToDocxBuffer,
} from './domain/latex-export-transpiler';

export interface ExportFormattedDocResult {
  filename: string;
  mimeType: string;
  content: string;
  isBase64: boolean;
  sizeBytes: number;
}

@Injectable()
export class DocstoreService {
  private readonly logger = new Logger(DocstoreService.name);
  private readonly getDocUseCase: GetDocUseCase;
  private readonly peekDocUseCase: PeekDocUseCase;
  private readonly updateDocUseCase: UpdateDocUseCase;
  private readonly patchDocUseCase: PatchDocUseCase;
  private readonly getAllDocsUseCase: GetAllDocsUseCase;
  private readonly archiveProjectUseCase: ArchiveProjectUseCase;

  constructor(
    private readonly docRepository: IDocRepository,
    @Optional() private readonly docHasher?: IDocHasher,
    @Optional() getDocUseCase?: GetDocUseCase,
    @Optional() peekDocUseCase?: PeekDocUseCase,
    @Optional() updateDocUseCase?: UpdateDocUseCase,
    @Optional() patchDocUseCase?: PatchDocUseCase,
    @Optional() getAllDocsUseCase?: GetAllDocsUseCase,
    @Optional() archiveProjectUseCase?: ArchiveProjectUseCase,
    @Optional() @Inject(IDocPersistor) docPersistor?: IDocPersistor,
  ) {
    const persistor =
      docPersistor ?? (docRepository as unknown as IDocPersistor);
    this.getDocUseCase =
      getDocUseCase ?? new GetDocUseCase(docRepository, persistor);
    this.peekDocUseCase =
      peekDocUseCase ?? new PeekDocUseCase(docRepository, persistor);
    this.updateDocUseCase =
      updateDocUseCase ?? new UpdateDocUseCase(docRepository, docHasher);
    this.patchDocUseCase =
      patchDocUseCase ?? new PatchDocUseCase(docRepository);
    this.getAllDocsUseCase =
      getAllDocsUseCase ??
      new GetAllDocsUseCase(docRepository, this.getDocUseCase);
    this.archiveProjectUseCase =
      archiveProjectUseCase ??
      new ArchiveProjectUseCase(docRepository, persistor, this.getDocUseCase);
  }

  public mapToDto(doc: TextDoc): DocResponseDto {
    return {
      _id: doc.id,
      id: doc.id,
      projectId: doc.projectId,
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
    options?: { includeDeleted?: boolean },
  ): Promise<DocResponseDto> {
    const doc = await this.getDocUseCase.execute(projectId, docId, options);
    return this.mapToDto(doc);
  }

  public async getDocById(docId: string): Promise<DocResponseDto | null> {
    const doc = await this.docRepository.getDocById(docId);
    if (!doc) return null;
    return this.mapToDto(doc);
  }

  public async peekDoc(
    projectId: string,
    docId: string,
  ): Promise<PeekDocResult> {
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

  public async createDoc(
    projectId: string,
    dto: CreateDocDto,
  ): Promise<DocResponseDto> {
    const lines =
      dto.lines || (dto.text ? LineArrayEngine.textToLines(dto.text) : ['']);
    LineArrayEngine.validateLinesSize(lines);

    const hash = this.docHasher
      ? this.docHasher.computeHash(lines)
      : computeDocSha256(lines);
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
    dto: UpdateDocDto,
  ): Promise<UpdateDocResult> {
    return await this.updateDocUseCase.execute(
      projectId,
      docId,
      dto.lines,
      dto.version,
      dto.ranges,
      dto.expectedRev ?? dto.rev,
    );
  }

  public async patchDoc(
    projectId: string,
    docId: string,
    dto: PatchDocDto,
  ): Promise<DocResponseDto> {
    const doc = await this.patchDocUseCase.execute(projectId, docId, {
      deleted: dto.deleted,
      name: dto.name ?? dto.path,
      deletedAt: dto.deletedAt ? new Date(dto.deletedAt) : undefined,
    });
    return this.mapToDto(doc);
  }

  /**
   * High-leverage deep operation: applies single or batch track-change suggestions
   * to a document's lines and persists the updated version.
   */
  public async applySuggestionsToDoc(
    projectId: string,
    docId: string,
    lines: string[],
    currentVersion: number,
    suggestions: TrackChangeSuggestionSpec | TrackChangeSuggestionSpec[],
  ): Promise<{ lines: string[]; result: UpdateDocResult }> {
    const mutatedLines = Array.isArray(suggestions)
      ? applyBatchSuggestionsToLines([...lines], suggestions)
      : applySuggestionToLines([...lines], suggestions);
    const result = await this.updateDoc(projectId, docId, {
      lines: mutatedLines,
      version: (currentVersion || 0) + 1,
    });
    return { lines: mutatedLines, result };
  }

  /**
   * High-leverage deep operation: resolves child LaTeX includes and transpiles
   * document content into TeX, Markdown, HTML, or DOCX format.
   */
  public transpileDocumentForExport(params: {
    rawFilename: string;
    content: string;
    format: string;
    projectDocs?: IncludedProjectDoc[];
  }): ExportFormattedDocResult {
    const format = (params.format || 'tex').toLowerCase();
    const rawFilename = params.rawFilename || 'document.tex';
    const baseName = rawFilename.replace(/\.[^/.]+$/, '');
    let content = params.content;

    if (params.projectDocs && params.projectDocs.length > 0) {
      const rootKey = rawFilename.toLowerCase();
      content = resolveIncludedLatexContent(
        content,
        params.projectDocs,
        new Set([rootKey, rootKey.replace(/\.tex$/i, '')]),
      );
    }

    if (format === 'docx') {
      const docxBuffer = convertLatexToDocxBuffer(content, baseName);
      return {
        filename: `${baseName}.docx`,
        mimeType:
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        content: docxBuffer.toString('base64'),
        isBase64: true,
        sizeBytes: docxBuffer.length,
      };
    }

    if (format === 'md' || format === 'markdown') {
      const mdContent = convertLatexToMarkdown(content, baseName);
      return {
        filename: `${baseName}.md`,
        mimeType: 'text/markdown',
        content: mdContent,
        isBase64: false,
        sizeBytes: Buffer.byteLength(mdContent, 'utf8'),
      };
    }

    if (format === 'html') {
      const htmlContent = convertLatexToHtml(content, baseName);
      return {
        filename: `${baseName}.html`,
        mimeType: 'text/html',
        content: htmlContent,
        isBase64: false,
        sizeBytes: Buffer.byteLength(htmlContent, 'utf8'),
      };
    }

    return {
      filename: rawFilename,
      mimeType: 'application/x-tex',
      content,
      isBase64: false,
      sizeBytes: Buffer.byteLength(content, 'utf8'),
    };
  }

  public async archiveDoc(projectId: string, docId: string): Promise<void> {
    await this.archiveProjectUseCase.archiveDoc(projectId, docId);
  }

  public async isDocDeleted(
    projectId: string,
    docId: string,
  ): Promise<boolean> {
    const doc = await this.getDocUseCase.execute(projectId, docId, {
      includeDeleted: true,
    });
    return doc.deleted;
  }

  public async getAllRanges(
    projectId: string,
  ): Promise<{ _id: string; ranges: DocRanges }[]> {
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
  public async getAsWorkspaceFiles(
    projectId: string,
  ): Promise<WorkspaceFile[]> {
    return await this.getAllDocsUseCase.executeAsWorkspaceFiles(projectId);
  }

  public getPrometheusMetrics(): string {
    return DocstoreMetrics.toPrometheus();
  }

  public getMetricsSummary(): DocstoreMetricsSummary {
    return DocstoreMetrics.getSummary();
  }
}
