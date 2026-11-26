import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { isUuid } from '@/core';
import {
  LIVE_COLLABORATION_PORT,
  LiveCollaborationPort,
  NOOP_LIVE_COLLABORATION,
} from '@/modules/pages/core';
import { resolveActiveProjectId } from '@/modules/pages/core/page-scope.helper';
import { DocstoreService } from '@/modules/pages/docstore/docstore.service';
import { ArchiveEntryVo } from '../domain/archive.domain';
import {
  IDocumentTranspilerPort,
  IPageArchiveHydratorPort,
  IZipEnginePort,
} from '../domain/archive.ports';
import {
  ExportFormattedDocResult,
  IncludedProjectDoc,
  resolveIncludedLatexContent,
  transpileLatexDocument,
} from '../domain/latex-export.domain';
import {
  LatexImportTranspiler,
  SupportedImportFormat,
  extractDocxMediaEntries,
  resolveImportFormat,
} from '../domain/latex-import.domain';
import { PandocAdapter } from '../adapters/pandoc.adapter';
import { ZipAdapter } from '../adapters/zip.adapter';
import { ImportSummaryResponseDto } from '../dto/import.dto';
import type {
  ConvertDocumentInput,
  TranspiledProjectResult,
} from '../types/archive.types';

interface ExportChainRequest {
  rawFilename: string;
  content: string;
  format: string;
  projectDocs?: IncludedProjectDoc[];
}

/**
 * GoF Chain of Responsibility for Outbound Document Export (`Pandoc` -> `In-Process Registry`).
 */
abstract class DocumentExportHandler {
  private nextHandler: DocumentExportHandler | null = null;

  public setNext(next: DocumentExportHandler): DocumentExportHandler {
    this.nextHandler = next;
    return next;
  }

  public async handle(req: ExportChainRequest): Promise<ExportFormattedDocResult> {
    const result = await this.tryExport(req);
    if (result) return result;
    if (this.nextHandler) return this.nextHandler.handle(req);
    return transpileLatexDocument(req);
  }

  protected abstract tryExport(
    req: ExportChainRequest,
  ): Promise<ExportFormattedDocResult | null>;
}

class PandocExportHandler extends DocumentExportHandler {
  constructor(private readonly pandoc: PandocAdapter) {
    super();
  }

  protected async tryExport(
    req: ExportChainRequest,
  ): Promise<ExportFormattedDocResult | null> {
    return this.pandoc.exportLatex({
      rawFilename: req.rawFilename,
      content: req.content,
      format: req.format,
    });
  }
}

class InProcessExportHandler extends DocumentExportHandler {
  protected async tryExport(
    req: ExportChainRequest,
  ): Promise<ExportFormattedDocResult> {
    return transpileLatexDocument(req);
  }
}

interface ImportChainRequest {
  format: SupportedImportFormat;
  buffer: Buffer;
  fileName: string;
}

/**
 * GoF Chain of Responsibility for Inbound Document Conversion (`Pandoc` -> `In-Process Strategy Registry`).
 */
abstract class DocumentImportHandler {
  private nextHandler: DocumentImportHandler | null = null;

  public setNext(next: DocumentImportHandler): DocumentImportHandler {
    this.nextHandler = next;
    return next;
  }

  public async handle(req: ImportChainRequest): Promise<TranspiledProjectResult> {
    const result = await this.tryImport(req);
    if (result) return result;
    if (this.nextHandler) return this.nextHandler.handle(req);
    throw new BadRequestException(
      `Unable to convert "${req.fileName}" (${req.format}).`,
    );
  }

  protected abstract tryImport(
    req: ImportChainRequest,
  ): Promise<TranspiledProjectResult | null>;
}

class PandocImportHandler extends DocumentImportHandler {
  constructor(
    private readonly pandoc: PandocAdapter,
    private readonly zipEngine: IZipEnginePort,
  ) {
    super();
  }

  protected async tryImport(
    req: ImportChainRequest,
  ): Promise<TranspiledProjectResult | null> {
    const latex = await this.pandoc.importToLatex({
      buffer: req.buffer,
      format: req.format,
    });
    if (!latex) return null;

    const mainEntry = ArchiveEntryVo.create(
      'main.tex',
      Buffer.from(latex, 'utf8'),
      false,
    );

    const mediaEntries =
      req.format === 'docx'
        ? this.safeExtractDocxMedia(req.buffer)
        : [];

    return {
      mainTex: latex,
      entries: [mainEntry, ...mediaEntries],
      detectedTitle: req.fileName.replace(/\.[^/.]+$/, ''),
      warnings: [],
    };
  }

  private safeExtractDocxMedia(docxBuffer: Buffer): ArchiveEntryVo[] {
    try {
      return extractDocxMediaEntries(this.zipEngine.extractZip(docxBuffer));
    } catch {
      return [];
    }
  }
}

class InProcessImportHandler extends DocumentImportHandler {
  constructor(private readonly transpiler: IDocumentTranspilerPort) {
    super();
  }

  protected async tryImport(
    req: ImportChainRequest,
  ): Promise<TranspiledProjectResult> {
    return this.transpiler.transpileByFormat(
      req.format,
      req.buffer,
      req.fileName,
    );
  }
}

@Injectable()
export class ConvertService {
  private readonly logger = new Logger(ConvertService.name);
  private readonly liveCollab: LiveCollaborationPort;
  private readonly exportChain: DocumentExportHandler;
  private readonly importChain: DocumentImportHandler;

  constructor(
    private readonly hydrator: IPageArchiveHydratorPort,
    @Optional() transpiler?: IDocumentTranspilerPort,
    @Optional() zipEngine?: IZipEnginePort,
    @Optional() private readonly docstoreService?: DocstoreService,
    @Optional()
    @Inject(LIVE_COLLABORATION_PORT)
    liveCollab?: LiveCollaborationPort,
    @Optional() pandoc?: PandocAdapter,
  ) {
    const resolvedZip = zipEngine ?? new ZipAdapter();
    const resolvedTranspiler =
      transpiler ?? new LatexImportTranspiler(resolvedZip);
    const resolvedPandoc = pandoc ?? new PandocAdapter();
    this.liveCollab = liveCollab ?? NOOP_LIVE_COLLABORATION;

    this.exportChain = new PandocExportHandler(resolvedPandoc);
    this.exportChain.setNext(new InProcessExportHandler());

    this.importChain = new PandocImportHandler(resolvedPandoc, resolvedZip);
    this.importChain.setNext(new InProcessImportHandler(resolvedTranspiler));
  }

  public async convertDocument(
    input: ConvertDocumentInput,
  ): Promise<ImportSummaryResponseDto> {
    const { projectId, fileBuffer, fileName, userId, pageId } = input;
    if (!fileBuffer || fileBuffer.length === 0) {
      throw new BadRequestException('Uploaded document payload is empty.');
    }

    const effectiveFormat = resolveImportFormat(input.format, fileName);
    if (!effectiveFormat) {
      throw new BadRequestException(
        `Unsupported document format for conversion: "${fileName}". Supported formats: .docx, .md, .markdown`,
      );
    }

    this.logger.log(
      `Converting ${effectiveFormat.toUpperCase()} document "${fileName}" (${fileBuffer.length} bytes) for project ${projectId}`,
    );

    const transpileResult = await this.importChain.handle({
      format: effectiveFormat,
      buffer: fileBuffer,
      fileName,
    });

    const summary = await this.hydrator.hydrateProjectEntries(
      projectId,
      transpileResult.entries,
      userId,
      'main.tex',
      pageId,
    );
    return summary.toJSON();
  }

  public exportDocumentFormat(params: {
    rawFilename: string;
    content: string;
    format: string;
    projectDocs?: IncludedProjectDoc[];
  }): ExportFormattedDocResult {
    return transpileLatexDocument(params);
  }

  public async exportSingleDocument(params: {
    pageId: string;
    format?: string;
    includeChildren?: boolean | string;
    project?: string | { id: string } | null;
  }): Promise<ExportFormattedDocResult> {
    const { pageId } = params;
    if (!isUuid(pageId)) {
      throw new BadRequestException('A valid UUID is required for pageId');
    }
    if (!this.docstoreService) {
      throw new BadRequestException(
        'DocstoreService is not configured for single document export',
      );
    }

    const activeProjectId = resolveActiveProjectId(params.project);
    let doc = activeProjectId
      ? await this.docstoreService
          .getDoc(activeProjectId, pageId)
          .catch(() => null)
      : await this.docstoreService.getDocById(pageId);

    if (!doc) {
      throw new NotFoundException(`Document ${pageId} not found`);
    }

    const docProjectId = doc.projectId || activeProjectId;
    const docPageId =
      (doc as { pageId?: string | null }).pageId ?? undefined;

    if (docProjectId) {
      const flushed = await this.liveCollab
        .flushDocs(docProjectId, [])
        .catch(() => []);
      if (flushed.length > 0) {
        doc =
          (await this.docstoreService
            .getDoc(docProjectId, pageId)
            .catch(() => null)) || doc;
      }
    }

    const format = (params.format || 'tex').toLowerCase();
    const rawFilename = doc.path?.replace(/^\//, '') || 'document.tex';
    let content = (doc.lines || []).join('\n');

    const rawIncludeFlag = params.includeChildren;
    const explicitExclude =
      rawIncludeFlag === false ||
      rawIncludeFlag === 'false' ||
      rawIncludeFlag === '0';
    const explicitInclude =
      rawIncludeFlag === true ||
      rawIncludeFlag === 'true' ||
      rawIncludeFlag === '1';
    const hasIncludeMacros = /\\(input|include|subfile)\s*\{[^}]+\}/.test(
      content,
    );

    if (
      docProjectId &&
      !explicitExclude &&
      (explicitInclude || hasIncludeMacros)
    ) {
      try {
        const projectDocs = await this.docstoreService.getAllDocs(
          docProjectId,
          docPageId,
        );
        if (projectDocs.length > 0) {
          const hydratedProjectDocs: IncludedProjectDoc[] = projectDocs.map(
            (pd) => ({
              id: pd.id || pd._id,
              path: pd.path,
              lines: pd.lines || [],
            }),
          );
          const rootKey = rawFilename.toLowerCase();
          content = resolveIncludedLatexContent(
            content,
            hydratedProjectDocs,
            new Set([rootKey, rootKey.replace(/\.tex$/i, '')]),
          );
        }
      } catch {
        // Fallback to unexpanded content if child doc query fails
      }
    }

    return this.exportChain.handle({ rawFilename, content, format });
  }
}
