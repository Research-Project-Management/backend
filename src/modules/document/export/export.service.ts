import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
  Optional,
} from '@nestjs/common';
import { PageService } from '../page/page.service';
import { CompilerService } from '../compiler/compiler.service';
import { AssetService } from '../asset/asset.service';
import { DocumentExportFormat, ExportDocumentDto } from './dto/export.dto';
import { toContentString } from '../page/utils/page.utils';
import { buildZipArchive, ZipFileEntry } from './utils/zip-builder.util';
import { getErrorMessage } from '@/core/utils/error.util';

export interface ExportFileResult {
  filename: string;
  mimeType: string;
  content: string; // base64 or raw string
  isBase64: boolean;
  sizeBytes: number;
}

export type ExportStrategyHandler = (
  page: any,
  userId: string,
  safeTitle: string,
) => Promise<ExportFileResult> | ExportFileResult;

const ARXIV_ALLOWED_EXTENSIONS = new Set([
  'tex',
  'ltx',
  'sty',
  'cls',
  'bst',
  'def',
  'fd',
  'cfg',
  'bbx',
  'cbx',
  'bib',
  'bbl',
  'png',
  'jpg',
  'jpeg',
  'pdf',
  'eps',
  'ps',
  'svg',
  'csv',
  'dat',
  'txt',
]);

function isArxivAllowed(filename: string): boolean {
  const clean = filename.trim().toLowerCase();
  if (clean.startsWith('.') || clean.startsWith('__macosx')) return false;
  if (/\.(aux|log|out|synctex\.gz|toc|lof|lot|fls|fdb_latexmk)$/i.test(clean)) {
    return false;
  }
  const ext = clean.split('.').pop() || '';
  return ARXIV_ALLOWED_EXTENSIONS.has(ext);
}

@Injectable()
export class ExportService {
  private readonly logger = new Logger(ExportService.name);
  private readonly strategies = new Map<string, ExportStrategyHandler>();

  constructor(
    private readonly pageService: PageService,
    private readonly compilerService: CompilerService,
    @Optional() private readonly assetService?: AssetService,
  ) {
    this.registerDefaultStrategies();
  }

  /**
   * Register a custom or specialized exporter strategy (Open/Closed Principle).
   */
  registerStrategy(format: string, handler: ExportStrategyHandler) {
    this.strategies.set(format.toLowerCase(), handler);
  }

  private registerDefaultStrategies() {
    this.registerStrategy(DocumentExportFormat.PDF, (page, userId, title) =>
      this.exportPdf(page, userId, title),
    );
    this.registerStrategy(DocumentExportFormat.MARKDOWN, (page, _, title) =>
      this.exportMarkdown(page, title),
    );
    this.registerStrategy(DocumentExportFormat.LATEX_SOURCE, (page, _, title) =>
      this.exportLatexSource(page, title),
    );
    this.registerStrategy(
      DocumentExportFormat.LATEX_SOURCE_UNDERSCORE,
      (page, _, title) => this.exportLatexSource(page, title),
    );
    this.registerStrategy(DocumentExportFormat.LATEX_BUNDLE, (page, _, title) =>
      this.exportLatexBundle(page, title, false),
    );
    this.registerStrategy(
      DocumentExportFormat.LATEX_BUNDLE_UNDERSCORE,
      (page, _, title) => this.exportLatexBundle(page, title, false),
    );
    this.registerStrategy(DocumentExportFormat.ZIP, (page, _, title) =>
      this.exportLatexBundle(page, title, false),
    );
    this.registerStrategy(DocumentExportFormat.ARXIV_ZIP, (page, _, title) =>
      this.exportLatexBundle(page, title, true),
    );
    this.registerStrategy(
      DocumentExportFormat.ARXIV_ZIP_UNDERSCORE,
      (page, _, title) => this.exportLatexBundle(page, title, true),
    );
    this.registerStrategy(DocumentExportFormat.LOG, (page, userId, title) =>
      this.exportLog(page, userId, title),
    );
    this.registerStrategy(DocumentExportFormat.BBL, (page, _, title) =>
      this.exportAuxiliaryFile(page, title, 'bbl'),
    );
    this.registerStrategy(DocumentExportFormat.AUX, (page, _, title) =>
      this.exportAuxiliaryFile(page, title, 'aux'),
    );
  }

  /**
   * Dispatches and orchestrates document export into the requested format via registered strategy.
   */
  async exportDocument(
    pageId: string,
    userId: string,
    dto: ExportDocumentDto,
  ): Promise<ExportFileResult> {
    const page = await this.pageService.findPageById(pageId);
    if (!page) {
      throw new NotFoundException(`Document ${pageId} not found`);
    }

    const safeTitle = (page.title || 'document')
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '_');

    const strategy = this.strategies.get((dto.format || '').toLowerCase());
    if (!strategy) {
      throw new BadRequestException(`Unsupported export format: ${dto.format}`);
    }

    return await strategy(page, userId, safeTitle);
  }

  private async exportPdf(
    page: any,
    userId: string,
    safeTitle: string,
  ): Promise<ExportFileResult> {
    const compileResult = await this.compilerService.compile(
      {
        page_id: page.id,
        project_id: page.projectId,
      },
      userId,
    );

    if (!compileResult.success) {
      throw new BadRequestException(
        compileResult.error || 'Failed to compile document to PDF for export',
      );
    }

    if (!compileResult.pdf) {
      throw new BadRequestException(
        'Failed to compile document to PDF for export: Empty PDF generated',
      );
    }

    const buffer = Buffer.from(compileResult.pdf, 'base64');

    return {
      filename: `${safeTitle}.pdf`,
      mimeType: 'application/pdf',
      content: compileResult.pdf,
      isBase64: true,
      sizeBytes: buffer.length,
    };
  }

  private exportMarkdown(page: any, safeTitle: string): ExportFileResult {
    let md = `# ${page.title}\n\n`;
    md += toContentString(page.content);

    if (page.childPages && page.childPages.length > 0) {
      for (const child of page.childPages) {
        md += `\n\n## ${child.title}\n\n`;
        md += toContentString(child.content);
      }
    }

    const buffer = Buffer.from(md, 'utf-8');

    return {
      filename: `${safeTitle}.md`,
      mimeType: 'text/markdown',
      content: md,
      isBase64: false,
      sizeBytes: buffer.length,
    };
  }

  private exportLatexSource(page: any, safeTitle: string): ExportFileResult {
    const source = toContentString(page.content);
    const buffer = Buffer.from(source, 'utf-8');

    return {
      filename: `${safeTitle}.tex`,
      mimeType: 'application/x-tex',
      content: source,
      isBase64: false,
      sizeBytes: buffer.length,
    };
  }

  /**
   * Overleaf-standard ZIP bundle export: packages all source .tex documents,
   * child pages, auto-resolved references.bib, and binary media assets into
   * a single compressed .zip archive.
   */
  private async exportLatexBundle(
    page: any,
    safeTitle: string,
    isArxiv = false,
  ): Promise<ExportFileResult> {
    const entries: ZipFileEntry[] = [];
    const textFiles: Map<string, string> = new Map();

    let mainFileName = 'main.tex';
    let mainSource = toContentString(page.content);

    if (page.childPages && page.childPages.length > 0) {
      for (const child of page.childPages) {
        const childFilename = child.title.endsWith('.tex')
          ? child.title
          : `${child.title.replace(/[^a-zA-Z0-9_.-]/g, '_')}.tex`;
        const childContent = toContentString(child.content);

        if (!isArxiv || isArxivAllowed(childFilename)) {
          textFiles.set(childFilename, childContent);
        }

        if (page.mainFileId && child.id === page.mainFileId) {
          mainFileName = childFilename;
          mainSource = childContent;
        }
      }
    }

    if (!textFiles.has(mainFileName)) {
      textFiles.set(mainFileName, mainSource);
    }

    for (const [path, content] of textFiles.entries()) {
      entries.push({ path, data: content });
    }

    // Mount binary and auxiliary project assets (figures, styles, bbl, fonts)
    if (this.assetService) {
      const effectiveProjId = page.projectId || page.id;
      try {
        const assetMap =
          await this.assetService.getProjectAssetMap(effectiveProjId);
        for (const [assetPath, assetBase64] of Object.entries(assetMap)) {
          if (isArxiv && !isArxivAllowed(assetPath)) continue;
          if (textFiles.has(assetPath)) continue; // don't override explicit text documents

          const buf = Buffer.from(assetBase64, 'base64');
          entries.push({ path: assetPath, data: buf });
        }
      } catch (err) {
        this.logger.warn(
          `Failed to mount project assets for ZIP export: ${getErrorMessage(err)}`,
        );
      }
    }

    const zipBuffer = buildZipArchive(entries);
    const filename = isArxiv ? `arxiv-${safeTitle}.zip` : `${safeTitle}.zip`;

    return {
      filename,
      mimeType: 'application/zip',
      content: zipBuffer.toString('base64'),
      isBase64: true,
      sizeBytes: zipBuffer.length,
    };
  }

  /**
   * Exports compilation logs (.log) for debugging or archiving.
   */
  private async exportLog(
    page: any,
    userId: string,
    safeTitle: string,
  ): Promise<ExportFileResult> {
    let logContent =
      'No compilation logs found. Please compile the document first.';
    try {
      const compileResult = await this.compilerService.compile(
        {
          page_id: page.id,
          project_id: page.projectId,
          use_cache: true,
        },
        userId,
      );
      if (compileResult.logs) {
        logContent = compileResult.logs;
      }
    } catch (err) {
      this.logger.warn(
        `Failed to retrieve compile logs for export: ${getErrorMessage(err)}`,
      );
    }

    const buf = Buffer.from(logContent, 'utf-8');
    return {
      filename: `${safeTitle}.log`,
      mimeType: 'text/plain',
      content: logContent,
      isBase64: false,
      sizeBytes: buf.length,
    };
  }

  /**
   * Exports auxiliary files such as .bbl (compiled bibliography) or .aux files.
   */
  private async exportAuxiliaryFile(
    page: any,
    safeTitle: string,
    ext: 'bbl' | 'aux',
  ): Promise<ExportFileResult> {
    let targetContent = '';

    // Check child pages for matching auxiliary files
    if (page.childPages && page.childPages.length > 0) {
      const matched = page.childPages.find((c: any) =>
        (c.title || '').toLowerCase().endsWith(`.${ext}`),
      );
      if (matched) {
        targetContent = toContentString(matched.content);
      }
    }

    // Check project asset store
    if (!targetContent && this.assetService) {
      try {
        const assetMap = await this.assetService.getProjectAssetMap(
          page.projectId || page.id,
        );
        for (const [path, base64] of Object.entries(assetMap)) {
          if (path.toLowerCase().endsWith(`.${ext}`)) {
            targetContent = Buffer.from(base64, 'base64').toString('utf-8');
            break;
          }
        }
      } catch {
        // ignore
      }
    }

    if (!targetContent) {
      targetContent = `% No .${ext} auxiliary file found for ${safeTitle}\n`;
    }

    const buf = Buffer.from(targetContent, 'utf-8');
    return {
      filename: `${safeTitle}.${ext}`,
      mimeType: ext === 'bbl' ? 'application/x-bibtex' : 'text/plain',
      content: targetContent,
      isBase64: false,
      sizeBytes: buf.length,
    };
  }
}
