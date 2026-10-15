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
import { IManuscriptAggregatorPort } from './core/ports/manuscript-aggregator.port';
import { IZipEnginePort } from './core/ports/zip-engine.port';
import { IManuscriptHydratorPort } from './core/ports/manuscript-hydrator.port';
import { ITemplateCatalogPort } from './core/ports/template-catalog.port';
import { IDocumentTranspilerPort } from './core/ports/document-transpiler.port';
import { PkzipEngineAdapter } from './core/adapters/engine/pkzip-engine.adapter';
import { EmbeddedTemplateCatalogAdapter } from './core/adapters/storage/embedded-template-catalog.adapter';
import { DocumentTranspilerAdapter } from './domain/document-transpiler';
import {
  ArchiveEntryVo,
  ArchiveManifest,
  ImportSummaryVo,
  ProjectTemplate,
  TemplateNotFoundException,
  validateExtractedArchiveEntries,
} from './domain/archive-validator';
import {
  ExportZipQueryDto,
  ImportSummaryResponseDto,
  TemplateResponseDto,
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

interface LegacyExportUseCaseLike {
  execute: (input: ExportProjectZipInput) => Promise<ExportProjectZipOutput>;
  executeStream: (
    input: ExportProjectZipInput,
  ) => Promise<ExportProjectZipStreamOutput>;
}

interface LegacyImportUseCaseLike {
  execute: (input: ImportProjectZipInput) => Promise<ImportSummaryVo>;
}

interface LegacyListTemplatesUseCaseLike {
  execute: () => Promise<ProjectTemplate[]>;
}

interface LegacyScaffoldUseCaseLike {
  execute: (input: ScaffoldTemplateInput) => Promise<ImportSummaryVo>;
}

interface LegacyConvertUseCaseLike {
  execute: (input: ConvertDocumentInput) => Promise<ImportSummaryVo>;
}

@Injectable()
export class ExportImportService {
  private readonly logger = new Logger(ExportImportService.name);
  private readonly aggregator?: IManuscriptAggregatorPort;
  private readonly zipEngine: IZipEnginePort;
  private readonly hydrator?: IManuscriptHydratorPort;
  private readonly catalog: ITemplateCatalogPort;
  private readonly transpiler: IDocumentTranspilerPort;

  // Legacy use-case delegates (populated only when constructed with legacy use-case instances in unit tests)
  private readonly legacyExportUseCase?: LegacyExportUseCaseLike;
  private readonly legacyImportUseCase?: LegacyImportUseCaseLike;
  private readonly legacyListTemplatesUseCase?: LegacyListTemplatesUseCaseLike;
  private readonly legacyScaffoldUseCase?: LegacyScaffoldUseCaseLike;
  private readonly legacyConvertUseCase?: LegacyConvertUseCaseLike;

  constructor(
    aggregatorOrExportUseCase:
      IManuscriptAggregatorPort | LegacyExportUseCaseLike,
    zipEngineOrImportUseCase?: IZipEnginePort | LegacyImportUseCaseLike,
    hydratorOrListTemplatesUseCase?:
      IManuscriptHydratorPort | LegacyListTemplatesUseCaseLike,
    @Optional()
    catalogOrScaffoldUseCase?: ITemplateCatalogPort | LegacyScaffoldUseCaseLike,
    @Optional()
    transpilerOrConvertUseCase?:
      IDocumentTranspilerPort | LegacyConvertUseCaseLike,
  ) {
    if (
      aggregatorOrExportUseCase &&
      'execute' in aggregatorOrExportUseCase &&
      typeof aggregatorOrExportUseCase.execute === 'function'
    ) {
      this.legacyExportUseCase = aggregatorOrExportUseCase;
      this.legacyImportUseCase =
        zipEngineOrImportUseCase as LegacyImportUseCaseLike;
      this.legacyListTemplatesUseCase =
        hydratorOrListTemplatesUseCase as LegacyListTemplatesUseCaseLike;
      this.legacyScaffoldUseCase =
        catalogOrScaffoldUseCase as LegacyScaffoldUseCaseLike;
      this.legacyConvertUseCase =
        transpilerOrConvertUseCase as LegacyConvertUseCaseLike;
      this.zipEngine = new PkzipEngineAdapter();
      this.catalog = new EmbeddedTemplateCatalogAdapter();
      this.transpiler = new DocumentTranspilerAdapter(this.zipEngine);
    } else {
      this.aggregator = aggregatorOrExportUseCase as IManuscriptAggregatorPort;
      this.zipEngine =
        (zipEngineOrImportUseCase as IZipEnginePort) ??
        new PkzipEngineAdapter();
      this.hydrator = hydratorOrListTemplatesUseCase as IManuscriptHydratorPort;
      this.catalog =
        (catalogOrScaffoldUseCase as ITemplateCatalogPort) ??
        new EmbeddedTemplateCatalogAdapter();
      this.transpiler =
        (transpilerOrConvertUseCase as IDocumentTranspilerPort) ??
        new DocumentTranspilerAdapter(this.zipEngine);
    }
  }

  public async collectProjectEntries(
    projectId: string,
    includePdf = false,
    cleanArxiv = false,
  ) {
    if (!this.aggregator) {
      throw new Error('Aggregator is not available');
    }
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
    if (!this.hydrator) {
      throw new Error('Hydrator is not available');
    }
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
    if (this.legacyExportUseCase) {
      return await this.legacyExportUseCase.execute({
        projectId,
        projectName: query?.projectName,
        includePdf: query?.includePdf,
        cleanArxiv: query?.cleanArxiv,
      });
    }

    const includePdf = query?.includePdf ?? false;
    const cleanArxiv = query?.cleanArxiv ?? false;
    const projectName = query?.projectName;

    const files = await this.aggregator!.collectProjectEntries(
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
    if (this.legacyExportUseCase) {
      return await this.legacyExportUseCase.executeStream({
        projectId,
        projectName: query?.projectName,
        includePdf: query?.includePdf,
        cleanArxiv: query?.cleanArxiv,
      });
    }

    const includePdf = query?.includePdf ?? false;
    const cleanArxiv = query?.cleanArxiv ?? false;
    const projectName = query?.projectName;

    const files = await this.aggregator!.collectLazyProjectEntries(
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
    if (this.legacyImportUseCase) {
      const summary = await this.legacyImportUseCase.execute({
        projectId,
        zipBuffer,
        userId,
        preferredRootDoc,
      });
      return summary.toJSON();
    }

    const entries = validateExtractedArchiveEntries(
      this.zipEngine.extractZip(zipBuffer),
    );
    const summary = await this.hydrator!.hydrateProjectEntries(
      projectId,
      entries,
      userId,
      preferredRootDoc,
    );
    return summary.toJSON();
  }

  public async listTemplates(): Promise<TemplateResponseDto[]> {
    const templates = this.legacyListTemplatesUseCase
      ? await this.legacyListTemplatesUseCase.execute()
      : await this.catalog.listTemplates();
    return templates.map((t) => t.toJSON());
  }

  public async getTemplate(
    templateId: string,
  ): Promise<TemplateResponseDto | null> {
    const templates = this.legacyListTemplatesUseCase
      ? await this.legacyListTemplatesUseCase.execute()
      : await this.catalog.listTemplates();
    const found = templates.find((t) => t.id === templateId);
    return found ? found.toJSON() : null;
  }

  public async scaffoldTemplate(
    projectId: string,
    templateId: string,
    userId?: string | null,
  ): Promise<ImportSummaryResponseDto> {
    if (this.legacyScaffoldUseCase) {
      const summary = await this.legacyScaffoldUseCase.execute({
        projectId,
        templateId,
        userId,
      });
      return summary.toJSON();
    }

    const template = await this.catalog.getTemplateById(templateId);
    if (!template) {
      throw new TemplateNotFoundException(templateId);
    }

    const entries: ArchiveEntryVo[] = template.files.map((file) => {
      const data = Buffer.isBuffer(file.content)
        ? file.content
        : Buffer.from(file.content, 'utf8');
      return ArchiveEntryVo.create(file.path, data, false);
    });

    const summary = await this.hydrator!.hydrateProjectEntries(
      projectId,
      entries,
      userId,
      template.defaultRootDoc,
    );
    return summary.toJSON();
  }

  public async convertDocument(
    input: ConvertDocumentInput,
  ): Promise<ImportSummaryResponseDto> {
    if (this.legacyConvertUseCase) {
      const summary = await this.legacyConvertUseCase.execute(input);
      return summary.toJSON();
    }

    if (!this.hydrator) {
      throw new Error('ConvertDocumentUseCase is not available');
    }

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
}
