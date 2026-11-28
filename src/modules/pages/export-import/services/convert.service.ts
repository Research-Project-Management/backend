import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { PrismaService, isUuid } from '@/core';
import {
  LIVE_COLLABORATION_PORT,
  LiveCollaborationPort,
  NOOP_LIVE_COLLABORATION,
  resolveActiveProjectId,
} from '@/modules/pages/core';
import { DocstoreService } from '@/modules/pages/docstore';
import { ArchiveEntryVo } from '../domain/archive.domain';
import {
  ExportFormattedDocResult,
  IncludedProjectDoc,
  resolveIncludedLatexContent,
  transpileLatexDocument,
} from '../domain/latex-export.domain';
import {
  SupportedImportFormat,
  extractDocxMediaEntries,
  resolveImportFormat,
  transpileDocxEntriesToLatex,
  transpileMarkdownToLatex,
} from '../domain/latex-import.domain';
import { PageArchiveHydratorAdapter } from '../adapters/hydrator.adapter';
import { PandocAdapter } from '../adapters/pandoc.adapter';
import { ZipAdapter } from '../adapters/zip.adapter';
import { ImportSummaryResponseDto } from '../dto/import.dto';
import type {
  ConvertDocumentInput,
  TranspiledProjectResult,
} from '../types/archive.types';

@Injectable()
export class ConvertService {
  private readonly logger = new Logger(ConvertService.name);
  private readonly zipEngine: ZipAdapter;
  private readonly pandoc: PandocAdapter;
  private readonly liveCollab: LiveCollaborationPort;

  constructor(
    private readonly hydrator: PageArchiveHydratorAdapter,
    @Optional() zipEngine?: ZipAdapter,
    @Optional() private readonly docstoreService?: DocstoreService,
    @Optional()
    @Inject(LIVE_COLLABORATION_PORT)
    liveCollab?: LiveCollaborationPort,
    @Optional() pandoc?: PandocAdapter,
    @Optional() private readonly prisma?: PrismaService,
  ) {
    this.zipEngine = zipEngine ?? new ZipAdapter();
    this.pandoc = pandoc ?? new PandocAdapter();
    this.liveCollab = liveCollab ?? NOOP_LIVE_COLLABORATION;
  }

  public async convertDocument(
    input: ConvertDocumentInput,
  ): Promise<ImportSummaryResponseDto> {
    const { projectId, fileBuffer, fileName, userId, pageId } = input;
    if (!fileBuffer || fileBuffer.length === 0) {
      throw new BadRequestException('Uploaded document payload is empty.');
    }

    const format = resolveImportFormat(input.format, fileName);
    if (!format) {
      throw new BadRequestException(
        `Unsupported document format for conversion: "${fileName}". Supported formats: .docx, .md, .markdown`,
      );
    }

    this.logger.log(
      `Converting ${format.toUpperCase()} document "${fileName}" (${fileBuffer.length} bytes) for project ${projectId}`,
    );

    const transpiled = await this.convertToLatexEntries(
      format,
      fileBuffer,
      fileName,
    );

    const strippedFileName = fileName
      .trim()
      .replace(/\.(docx|md|markdown)$/i, '')
      .trim();
    const fallbackTitle =
      transpiled.detectedTitle?.trim() ||
      (strippedFileName && strippedFileName.toLowerCase() !== 'document'
        ? strippedFileName
        : undefined);

    const explicitPageId = pageId?.trim() || undefined;
    const summary = await this.hydrator.hydrateProjectEntries(
      projectId,
      transpiled.entries,
      userId,
      {
        preferredRootDoc: 'main.tex',
        defaultTitle: fallbackTitle,
        createNewPage: input.createNewPage ?? !explicitPageId,
      },
      explicitPageId,
    );
    return summary.toJSON();
  }

  private async convertToLatexEntries(
    format: SupportedImportFormat,
    buffer: Buffer,
    fileName: string,
  ): Promise<TranspiledProjectResult> {
    const docxEntries =
      format === 'docx' ? await this.zipEngine.extractZip(buffer) : null;

    const pandocLatex = await this.pandoc.importToLatex({ buffer, format });
    if (pandocLatex) {
      const mainEntry = ArchiveEntryVo.create(
        'main.tex',
        Buffer.from(pandocLatex, 'utf8'),
        false,
      );
      const mediaEntries = docxEntries
        ? extractDocxMediaEntries(docxEntries)
        : [];
      return {
        mainTex: pandocLatex,
        entries: [mainEntry, ...mediaEntries],
        detectedTitle: fileName.replace(/\.[^/.]+$/, ''),
        warnings: [],
      };
    }

    if (format === 'docx') {
      return transpileDocxEntriesToLatex(docxEntries!, fileName);
    }
    return transpileMarkdownToLatex(buffer.toString('utf8'), fileName);
  }

  public async exportSpaceDocument(params: {
    spaceId: string;
    pageId?: string;
    format?: string;
    includeChildren?: boolean | string;
  }): Promise<ExportFormattedDocResult> {
    const { spaceId, format, includeChildren } = params;
    let targetDocOrPageId = params.pageId?.trim() || undefined;

    if (!targetDocOrPageId && this.prisma?.page?.findFirst) {
      const page = await Promise.resolve(
        this.prisma.page.findFirst({
          where: { spaceId, deletedAt: null },
          orderBy: { createdAt: 'asc' },
          select: { id: true, rootDocId: true },
        }),
      ).catch(() => null);
      targetDocOrPageId = page?.rootDocId || page?.id;
    } else if (
      targetDocOrPageId &&
      isUuid(targetDocOrPageId) &&
      this.prisma?.page?.findFirst
    ) {
      const page = await Promise.resolve(
        this.prisma.page.findFirst({
          where: { id: targetDocOrPageId, spaceId, deletedAt: null },
          select: { id: true, rootDocId: true },
        }),
      ).catch(() => null);
      if (page?.rootDocId) {
        targetDocOrPageId = page.rootDocId;
      }
    }

    if (!targetDocOrPageId) {
      throw new NotFoundException(`No exportable document found in space ${spaceId}`);
    }

    return this.exportSingleDocument({
      pageId: targetDocOrPageId,
      format,
      includeChildren,
      project: spaceId,
    });
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
    let targetDocId = pageId;
    let doc = activeProjectId
      ? await this.docstoreService
          .getDoc(activeProjectId, targetDocId)
          .catch(() => null)
      : await this.docstoreService.getDocById(targetDocId);

    if (!doc && this.prisma?.page?.findFirst) {
      const page = await Promise.resolve(
        this.prisma.page.findFirst({
          where: {
            id: pageId,
            ...(activeProjectId ? { spaceId: activeProjectId } : {}),
            deletedAt: null,
          },
          select: { spaceId: true, rootDocId: true },
        }),
      ).catch(() => null);
      if (page?.rootDocId) {
        targetDocId = page.rootDocId;
        const lookupSpaceId = activeProjectId || page.spaceId;
        doc = lookupSpaceId
          ? await this.docstoreService
              .getDoc(lookupSpaceId, targetDocId)
              .catch(() => null)
          : await this.docstoreService.getDocById(targetDocId);
      }
    }

    if (!doc) {
      throw new NotFoundException(`Document ${pageId} not found`);
    }

    const docProjectId = doc.projectId || activeProjectId;
    const docPageId = (doc as { pageId?: string | null }).pageId ?? undefined;

    if (docProjectId) {
      const flushed = await this.liveCollab
        .flushDocs(docProjectId, [targetDocId])
        .catch(() => []);
      if (flushed.length > 0) {
        doc =
          (await this.docstoreService
            .getDoc(docProjectId, targetDocId)
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

    const pandocExport = await this.pandoc.exportLatex({
      rawFilename,
      content,
      format,
    });
    return (
      pandocExport ?? transpileLatexDocument({ rawFilename, content, format })
    );
  }
}
