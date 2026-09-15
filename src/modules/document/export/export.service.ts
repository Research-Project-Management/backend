import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { CoreService } from '../core/core.service';
import { CompilerService } from '../compiler/compiler.service';
import { DocumentExportFormat, ExportDocumentDto } from './dto/export.dto';

export interface ExportFileResult {
  filename: string;
  mimeType: string;
  content: string; // base64 or raw string
  isBase64: boolean;
  sizeBytes: number;
}

@Injectable()
export class ExportService {
  private readonly logger = new Logger(ExportService.name);

  constructor(
    private readonly coreService: CoreService,
    private readonly compilerService: CompilerService,
  ) {}

  /**
   * Dispatches and orchestrates document export into the requested format.
   */
  async exportDocument(
    pageId: string,
    userId: string,
    dto: ExportDocumentDto,
  ): Promise<ExportFileResult> {
    const page = await this.coreService.findPageById(pageId);
    if (!page) {
      throw new NotFoundException(`Document ${pageId} not found`);
    }

    const safeTitle = (page.title || 'document')
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '_');

    switch (dto.format) {
      case DocumentExportFormat.PDF:
        return this.exportPdf(page, userId, safeTitle);

      case DocumentExportFormat.MARKDOWN:
        return this.exportMarkdown(page, safeTitle);

      case DocumentExportFormat.LATEX_SOURCE:
        return this.exportLatexSource(page, safeTitle);

      case DocumentExportFormat.LATEX_BUNDLE:
        return this.exportLatexBundle(page, safeTitle);

      default:
        throw new BadRequestException(
          `Unsupported export format: ${dto.format}`,
        );
    }
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

    if (typeof page.content === 'string') {
      md += page.content;
    } else if (page.content) {
      md += JSON.stringify(page.content, null, 2);
    }

    if (page.childPages && page.childPages.length > 0) {
      for (const child of page.childPages) {
        md += `\n\n## ${child.title}\n\n`;
        if (typeof child.content === 'string') {
          md += child.content;
        } else if (child.content) {
          md += JSON.stringify(child.content, null, 2);
        }
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
    let source = '';
    if (typeof page.content === 'string') {
      source = page.content;
    } else if (page.content) {
      source = JSON.stringify(page.content);
    }

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

    const mainSource =
      typeof page.content === 'string'
        ? page.content
        : JSON.stringify(page.content || '');
    files['main.tex'] = mainSource;

    if (page.childPages) {
      for (const child of page.childPages) {
        const childFilename = child.title.endsWith('.tex')
          ? child.title
          : `${child.title.replace(/[^a-zA-Z0-9_-]/g, '_')}.tex`;
        files[childFilename] =
          typeof child.content === 'string'
            ? child.content
            : JSON.stringify(child.content || '');
      }
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
