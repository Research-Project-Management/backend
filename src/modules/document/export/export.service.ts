import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PageService } from '../page/page.service';
import { CompilerService } from '../compiler/compiler.service';
import { DocumentExportFormat, ExportDocumentDto } from './dto/export.dto';
import { toContentString } from '../page/utils/page.utils';

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

@Injectable()
export class ExportService {
  private readonly logger = new Logger(ExportService.name);
  private readonly strategies = new Map<string, ExportStrategyHandler>();

  constructor(
    private readonly pageService: PageService,
    private readonly compilerService: CompilerService,
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
      this.exportLatexBundle(page, title),
    );
    this.registerStrategy(
      DocumentExportFormat.LATEX_BUNDLE_UNDERSCORE,
      (page, _, title) => this.exportLatexBundle(page, title),
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

  private exportLatexBundle(page: any, safeTitle: string): ExportFileResult {
    const files: Record<string, string> = {};

    let mainFileName = 'main.tex';
    let mainSource = toContentString(page.content);

    if (page.childPages && page.childPages.length > 0) {
      for (const child of page.childPages) {
        const childFilename = child.title.endsWith('.tex')
          ? child.title
          : `${child.title.replace(/[^a-zA-Z0-9_-]/g, '_')}.tex`;
        const childContent = toContentString(child.content);
        files[childFilename] = childContent;

        if (page.mainFileId && child.id === page.mainFileId) {
          mainFileName = childFilename;
          mainSource = childContent;
        }
      }
    }

    if (!files[mainFileName]) {
      files[mainFileName] = mainSource;
    }

    const bundleJson = JSON.stringify(files, null, 2);
    const buffer = Buffer.from(bundleJson, 'utf-8');

    return {
      filename: `${safeTitle}-bundle.json`,
      mimeType: 'application/json',
      content: bundleJson,
      isBase64: false,
      sizeBytes: buffer.length,
    };
  }
}
