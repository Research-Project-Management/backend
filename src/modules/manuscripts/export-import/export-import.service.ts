/**
 * modules/manuscripts/export-import/export-import.service.ts
 * Deep service orchestrating Project Archiving, ZIP Export/Import, Template Scaffolding,
 * and Document Conversion directly without shallow pass-through use-case ceremony.
 */

import {
  BadRequestException,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import {
  IManuscriptAggregatorPort,
  IZipEnginePort,
  IManuscriptHydratorPort,
  IDocumentTranspilerPort,
  ArchiveEntryVo,
  ArchiveManifest,
  ImportSummaryVo,
  validateExtractedArchiveEntries,
  IncludedProjectDoc,
  ExportFormattedDocResult,
  transpileLatexDocumentForExport,
} from './domain';
import { PkzipEngineAdapter } from './services/pkzip-engine.adapter';
import { DocumentTranspilerAdapter } from './services/document-transpiler.adapter';
import { TemplatesService } from '@/modules/manuscripts/templates/templates.service';
import { TemplateNotFoundException } from '@/modules/manuscripts/templates/domain';
import {
  ExportZipQueryDto,
  ImportSummaryResponseDto,
} from './dto/export-import.dto';

export interface ExportProjectZipInput {
  projectId: string;
  projectName?: string;
  includePdf?: boolean;
  cleanArxiv?: boolean;
}

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

export interface ImportProjectZipInput {
  projectId: string;
  zipBuffer: Buffer;
  userId?: string | null;
  preferredRootDoc?: string;
}

export interface ScaffoldTemplateInput {
  projectId: string;
  templateId: string;
  userId?: string | null;
}

export interface ConvertDocumentInput {
  projectId: string;
  fileBuffer: Buffer;
  fileName: string;
  format?: 'docx' | 'md';
  userId?: string | null;
}

@Injectable()
export class ExportImportService {
  private readonly logger = new Logger(ExportImportService.name);
  private readonly aggregator: IManuscriptAggregatorPort;
  private readonly zipEngine: IZipEnginePort;
  private readonly hydrator: IManuscriptHydratorPort;
  private readonly templatesService?: TemplatesService;
  private readonly transpiler: IDocumentTranspilerPort;

  constructor(
    aggregator: IManuscriptAggregatorPort,
    zipEngine: IZipEnginePort = new PkzipEngineAdapter(),
    hydrator: IManuscriptHydratorPort,
    @Optional() templatesService?: TemplatesService,
    @Optional() transpiler?: IDocumentTranspilerPort,
  ) {
    this.aggregator = aggregator;
    this.zipEngine = zipEngine;
    this.hydrator = hydrator;
    this.templatesService = templatesService;
    this.transpiler =
      transpiler ?? new DocumentTranspilerAdapter(this.zipEngine);
  }

  public async collectProjectEntries(
    projectId: string,
    includePdf = false,
    cleanArxiv = false,
  ) {
    return await this.aggregator.collectProjectEntries(
      projectId,
      includePdf,
      cleanArxiv,
    );
  }

  public async hydrateProjectEntries(
    projectId: string,
    entries: ArchiveEntryVo[],
    userId?: string | null,
    preferredRootDoc?: string,
  ): Promise<ImportSummaryVo> {
    return await this.hydrator.hydrateProjectEntries(
      projectId,
      entries,
      userId,
      preferredRootDoc,
    );
  }

  public async exportProjectZip(
    projectId: string,
    query?: ExportZipQueryDto,
  ): Promise<ExportProjectZipOutput> {
    const includePdf = query?.includePdf ?? false;
    const cleanArxiv = query?.cleanArxiv ?? false;
    const projectName = query?.projectName;

    const files = await this.aggregator.collectProjectEntries(
      projectId,
      includePdf,
      cleanArxiv,
    );

    if (files.length === 0) {
      files.push({
        path: 'main.tex',
        data: Buffer.from(
          '\\documentclass{article}\n\\begin{document}\nHello World\n\\end{document}',
          'utf8',
        ),
      });
    }

    const zipBuffer = this.zipEngine.buildZip(files);
    const hasPdf = files.some((f) => f.path.toLowerCase().endsWith('.pdf'));
    const resolvedName = cleanArxiv
      ? projectName?.startsWith('arxiv-')
        ? projectName
        : `arxiv-${projectName || 'manuscript'}`
      : projectName;

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
    const includePdf = query?.includePdf ?? false;
    const cleanArxiv = query?.cleanArxiv ?? false;
    const projectName = query?.projectName;

    const files = await this.aggregator.collectLazyProjectEntries(
      projectId,
      includePdf,
      cleanArxiv,
    );

    if (files.length === 0) {
      files.push({
        path: 'main.tex',
        data: Buffer.from(
          '\\documentclass{article}\n\\begin{document}\nHello World\n\\end{document}',
          'utf8',
        ),
      });
    }

    const zipStream = this.zipEngine.createZipStream(files);
    const hasPdf = files.some((f) => f.path.toLowerCase().endsWith('.pdf'));
    const resolvedName = cleanArxiv
      ? projectName?.startsWith('arxiv-')
        ? projectName
        : `arxiv-${projectName || 'manuscript'}`
      : projectName || 'manuscript';

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
  ): Promise<ImportSummaryResponseDto> {
    const entries = validateExtractedArchiveEntries(
      this.zipEngine.extractZip(zipBuffer),
    );
    const summary = await this.hydrator.hydrateProjectEntries(
      projectId,
      entries,
      userId,
      preferredRootDoc,
    );
    return summary.toJSON();
  }

  public async scaffoldTemplate(
    projectId: string,
    templateId: string,
    userId?: string | null,
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
    );
    return summary.toJSON();
  }

  public async convertDocument(
    input: ConvertDocumentInput,
  ): Promise<ImportSummaryResponseDto> {
    const { projectId, fileBuffer, fileName, userId } = input;
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
    );
    return summary.toJSON();
  }

  public exportDocumentFormat(params: {
    rawFilename: string;
    content: string;
    format: string;
    projectDocs?: IncludedProjectDoc[];
  }): ExportFormattedDocResult {
    return transpileLatexDocumentForExport(params);
  }
}
