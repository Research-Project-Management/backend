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

function toContentString(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object') {
    const obj = content as Record<string, unknown>;
    return (
      (obj.source as string) ||
      (obj.text as string) ||
      (obj.content as string) ||
      JSON.stringify(content)
    );
  }
  return '';
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
      case DocumentExportFormat.LATEX_SOURCE_UNDERSCORE:
        return this.exportLatexSource(page, safeTitle);

      case DocumentExportFormat.LATEX_BUNDLE:
      case DocumentExportFormat.LATEX_BUNDLE_UNDERSCORE:
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
