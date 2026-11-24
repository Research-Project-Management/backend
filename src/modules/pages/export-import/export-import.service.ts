/**
 * modules/manuscripts/export-import/export-import.service.ts
 * Deep service orchestrating Project Archiving, ZIP Export/Import, Template Scaffolding,
 * and Document Conversion directly without shallow pass-through use-case ceremony.
 */

import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { isUuid } from '@/core';
import {
  LIVE_COLLABORATION_PORT,
  LiveCollaborationPort,
  NOOP_LIVE_COLLABORATION,
} from '@/modules/pages/core';
import {
  getRecordSpaceId,
  isRecordDeleted,
  resolveActiveProjectId,
} from '@/modules/pages/core/page-scope.helper';
import { DocstoreService } from '@/modules/pages/docstore/docstore.service';
import { ScopeRepository } from '@/modules/pages/docstore/repositories/scope.repository';
import { hydratePageDocLines } from '@/modules/pages/docstore/services/doc-occ.helper';
import {
  IPageArchiveAggregatorPort,
  IZipEnginePort,
  IPageArchiveHydratorPort,
  IDocumentTranspilerPort,
  ArchiveEntryVo,
  ArchiveManifest,
  ImportSummaryVo,
  validateExtractedArchiveEntries,
  IncludedProjectDoc,
  ExportFormattedDocResult,
  resolveIncludedLatexContent,
  transpileLatexDocument,
} from './domain';
import { ZipAdapter } from './services/zip.adapter';
import { TranspilerAdapter } from './services/transpiler.adapter';
import {
  PageArchiveAggregatorAdapter,
  PageArchiveHydratorAdapter,
} from './repositories/aggregator.repository';
import { TemplatesService } from '@/modules/pages/templates/templates.service';
import { TemplateNotFoundException } from '@/modules/pages/templates/domain';
import { HistoryService } from '@/modules/pages/history/services/history.service';
import {
  ExportZipQueryDto,
  ImportSummaryResponseDto,
} from './dto/export-import.dto';

export interface ExportProjectZipOutput {
  zipBuffer: Buffer;
  manifest: ArchiveManifest;
}

export interface ExportProjectZipStreamOutput {
  zipStream: Readable;
  projectName: string;
  fileCount: number;
  hasCompiledPdf: boolean;
}

export interface ConvertDocumentInput {
  projectId: string;
  fileBuffer: Buffer;
  fileName: string;
  format?: 'docx' | 'md';
  userId?: string | null;
  pageId?: string;
}

@Injectable()
export class ExportImportService {
  private readonly logger = new Logger(ExportImportService.name);
  private readonly aggregator: IPageArchiveAggregatorPort;
  private readonly zipEngine: IZipEnginePort;
  private readonly hydrator: IPageArchiveHydratorPort;
  private readonly templatesService?: TemplatesService;
  private readonly transpiler: IDocumentTranspilerPort;
  private readonly projectHistoryService?: HistoryService;
  private readonly docstoreService?: DocstoreService;
  private readonly pageScopeRepo?: ScopeRepository;
  private readonly liveCollab: LiveCollaborationPort;

  constructor(
    aggregator: PageArchiveAggregatorAdapter,
    zipEngine: ZipAdapter = new ZipAdapter(),
    hydrator: PageArchiveHydratorAdapter,
    @Optional() templatesService?: TemplatesService,
    @Optional() transpiler?: TranspilerAdapter,
    @Optional() projectHistoryService?: HistoryService,
    @Optional() docstoreService?: DocstoreService,
    @Optional() pageScopeRepo?: ScopeRepository,
    @Optional()
    @Inject(LIVE_COLLABORATION_PORT)
    liveCollabOrLegacyRef?: LiveCollaborationPort | unknown,
  ) {
    this.aggregator = aggregator;
    this.zipEngine = zipEngine;
    this.hydrator = hydrator;
    this.templatesService = templatesService;
    this.transpiler =
      transpiler ?? new TranspilerAdapter(this.zipEngine as ZipAdapter);
    this.projectHistoryService = projectHistoryService;
    this.docstoreService = docstoreService;
    this.pageScopeRepo = pageScopeRepo;
    this.liveCollab =
      liveCollabOrLegacyRef &&
      typeof (liveCollabOrLegacyRef as LiveCollaborationPort)
        .applyExternalText === 'function'
        ? (liveCollabOrLegacyRef as LiveCollaborationPort)
        : NOOP_LIVE_COLLABORATION;
  }

  public async collectProjectEntries(
    projectId: string,
    includePdf = false,
    cleanArxiv = false,
    pageId?: string,
  ) {
    return await this.aggregator.collectProjectEntries(
      projectId,
      includePdf,
      cleanArxiv,
      pageId,
    );
  }

  public async hydrateProjectEntries(
    projectId: string,
    entries: ArchiveEntryVo[],
    userId?: string | null,
    preferredRootDoc?: string,
    pageId?: string,
  ): Promise<ImportSummaryVo> {
    return await this.hydrator.hydrateProjectEntries(
      projectId,
      entries,
      userId,
      preferredRootDoc,
      pageId,
    );
  }

  private static readonly DEFAULT_MAIN_TEX_FALLBACK = Buffer.from(
    '\\documentclass{article}\n\\begin{document}\nHello World\n\\end{document}',
    'utf8',
  );

  /**
   * Shared Template Method / Plan resolver for both buffered and streaming ZIP exports.
   * Ensures identical fallback `main.tex` generation, PDF detection, and `arxiv-` naming.
   */
  private prepareExportPlan<T extends { path: string }>(
    files: T[],
    createFallbackEntry: (path: string, data: Buffer) => T,
    query?: ExportZipQueryDto,
  ): {
    files: T[];
    hasPdf: boolean;
    resolvedName: string;
  } {
    const cleanArxiv =
      (query?.cleanArxiv ?? false) || query?.mode?.toLowerCase() === 'arxiv';
    const projectName = query?.projectName;

    if (files.length === 0) {
      files.push(
        createFallbackEntry(
          'main.tex',
          ExportImportService.DEFAULT_MAIN_TEX_FALLBACK,
        ),
      );
    }

    const hasPdf = files.some((f) => f.path.toLowerCase().endsWith('.pdf'));
    const baseName = projectName || 'manuscript';
    const resolvedName = cleanArxiv
      ? projectName?.startsWith('arxiv-')
        ? projectName
        : `arxiv-${baseName}`
      : baseName;

    return {
      files,
      hasPdf,
      resolvedName,
    };
  }

  public async exportProjectZip(
    projectId: string,
    query?: ExportZipQueryDto,
  ): Promise<ExportProjectZipOutput> {
    const cleanArxiv =
      (query?.cleanArxiv ?? false) || query?.mode?.toLowerCase() === 'arxiv';
    const includePdf = query?.includePdf ?? false;

    const collected = await this.aggregator.collectProjectEntries(
      projectId,
      includePdf,
      cleanArxiv,
      query?.pageId,
    );

    const { files, hasPdf, resolvedName } = this.prepareExportPlan(
      collected,
      (entryPath, data) => ({ path: entryPath, data }),
      query,
    );

    const zipBuffer = this.zipEngine.buildZip(files);

    const manifest = new ArchiveManifest({
      projectId,
      projectName: resolvedName,
      fileCount: files.length,
      totalSizeBytes: zipBuffer.length,
      hasCompiledPdf: hasPdf,
    });

    return {
      zipBuffer,
      manifest,
    };
  }

  public async exportProjectZipStream(
    projectId: string,
    query?: ExportZipQueryDto,
  ): Promise<ExportProjectZipStreamOutput> {
    if (query?.version && this.projectHistoryService) {
      const versionResult =
        await this.projectHistoryService.exportVersionZipStream(
          projectId,
          Number(query.version),
          query.projectName,
          query.pageId,
        );
      return {
        zipStream: versionResult.zipStream,
        projectName: versionResult.filename.replace(/\.zip$/i, ''),
        fileCount: versionResult.fileCount,
        hasCompiledPdf: false,
      };
    }

    const cleanArxiv =
      (query?.cleanArxiv ?? false) || query?.mode?.toLowerCase() === 'arxiv';
    const includePdf = query?.includePdf ?? false;

    const collected = await this.aggregator.collectLazyProjectEntries(
      projectId,
      includePdf,
      cleanArxiv,
      query?.pageId,
    );

    const { files, hasPdf, resolvedName } = this.prepareExportPlan(
      collected,
      (entryPath, data) => ({ path: entryPath, data }),
      query,
    );

    const zipStream = this.zipEngine.createZipStream(files);

    return {
      zipStream,
      projectName: resolvedName,
      fileCount: files.length,
      hasCompiledPdf: hasPdf,
    };
  }

  public async importProjectZip(
    projectId: string,
    zipBuffer: Buffer,
    userId?: string | null,
    preferredRootDoc?: string,
    pageId?: string,
  ): Promise<ImportSummaryResponseDto> {
    const entries = validateExtractedArchiveEntries(
      this.zipEngine.extractZip(zipBuffer),
    );
    const summary = await this.hydrator.hydrateProjectEntries(
      projectId,
      entries,
      userId,
      preferredRootDoc,
      pageId,
    );
    return summary.toJSON();
  }

  public async scaffoldTemplate(
    projectId: string,
    templateId: string,
    userId?: string | null,
    pageId?: string,
  ): Promise<ImportSummaryResponseDto> {
    if (!this.templatesService) {
      throw new TemplateNotFoundException(templateId);
    }

    const template = await this.templatesService.getTemplate(templateId);
    if (!template) {
      throw new TemplateNotFoundException(templateId);
    }

    const entries: ArchiveEntryVo[] = Object.entries(template.files || {}).map(
      ([filePath, content]) => {
        const data = Buffer.isBuffer(content)
          ? content
          : Buffer.from(String(content), 'utf8');
        return ArchiveEntryVo.create(filePath, data, false);
      },
    );

    const summary = await this.hydrator.hydrateProjectEntries(
      projectId,
      entries,
      userId,
      template.mainFile || 'main.tex',
      pageId,
    );
    return summary.toJSON();
  }

  public async convertDocument(
    input: ConvertDocumentInput,
  ): Promise<ImportSummaryResponseDto> {
    const { projectId, fileBuffer, fileName, userId, pageId } = input;
    if (!fileBuffer || fileBuffer.length === 0) {
      throw new BadRequestException('Uploaded document payload is empty.');
    }

    const ext = path.extname(fileName).toLowerCase();
    const effectiveFormat =
      input.format || (ext === '.docx' ? 'docx' : ext === '.md' ? 'md' : null);

    if (!effectiveFormat) {
      throw new BadRequestException(
        `Unsupported document format for conversion: "${ext}". Supported formats: .docx, .md`,
      );
    }

    this.logger.log(
      `Converting ${effectiveFormat.toUpperCase()} document "${fileName}" (${fileBuffer.length} bytes) for project ${projectId}`,
    );

    const transpileResult =
      effectiveFormat === 'docx'
        ? await this.transpiler.transpileDocx(fileBuffer, fileName)
        : await this.transpiler.transpileMarkdown(
            fileBuffer.toString('utf8'),
            fileName,
          );

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
    if (!this.docstoreService || !this.pageScopeRepo) {
      throw new BadRequestException(
        'Docstore dependencies are not configured for single document export',
      );
    }

    const activeProjectId = resolveActiveProjectId(params.project);
    let doc = activeProjectId
      ? await this.pageScopeRepo.findDocInProject(activeProjectId, pageId)
      : null;
    if (!doc || isRecordDeleted(doc)) {
      throw new NotFoundException(`Document ${pageId} not found`);
    }

    const docProjectId = getRecordSpaceId(doc);
    const docPageId =
      (doc as { pageId?: string | null } | null)?.pageId ?? undefined;
    if (docProjectId) {
      const flushed = await this.liveCollab
        .flushDocs(docProjectId, [])
        .catch(() => []);
      if (flushed.length > 0) {
        doc =
          (await this.pageScopeRepo.findDocInProject(docProjectId, pageId)) ||
          doc;
      }
    }

    const format = (params.format || 'tex').toLowerCase();
    const docWithNode = doc as typeof doc & {
      path?: string;
      node?: { path?: string | null } | null;
    };
    const rawPath =
      docWithNode.node?.path || docWithNode.lastKnownPath || docWithNode.path;
    const rawFilename = rawPath?.replace(/^\//, '') || 'document.tex';
    const hydratedLines = await hydratePageDocLines(this.docstoreService, doc);
    let content = hydratedLines.join('\n');

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
          const hydratedProjectDocs = await Promise.all(
            projectDocs.map(async (pd) => ({
              id: pd.id || pd._id,
              path: pd.path,
              lines: await hydratePageDocLines(this.docstoreService!, {
                id: pd.id || pd._id,
                projectId: pd.projectId || docProjectId,
                lines: pd.lines,
                inStorage: pd.inStorage,
              }),
            })),
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

    return this.exportDocumentFormat({ rawFilename, content, format });
  }
}
