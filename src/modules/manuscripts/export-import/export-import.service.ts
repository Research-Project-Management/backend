/**
 * export-import/export-import.service.ts
 * Facade Service orchestrating Project Archiving, ZIP Export/Import, and Template Scaffolding.
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  ExportProjectZipUseCase,
  ExportProjectZipOutput,
} from './core/use-cases/export-project-zip.use-case';
import { ImportProjectZipUseCase } from './core/use-cases/import-project-zip.use-case';
import { ListTemplatesUseCase } from './core/use-cases/list-templates.use-case';
import { ScaffoldTemplateUseCase } from './core/use-cases/scaffold-template.use-case';
import {
  ConvertDocumentUseCase,
  ConvertDocumentInput,
} from './core/use-cases/convert-document.use-case';
import {
  ExportZipQueryDto,
  ImportSummaryResponseDto,
  TemplateResponseDto,
} from './dto/export-import.dto';

@Injectable()
export class ExportImportService {
  private readonly logger = new Logger(ExportImportService.name);

  constructor(
    private readonly exportProjectZipUseCase: ExportProjectZipUseCase,
    private readonly importProjectZipUseCase: ImportProjectZipUseCase,
    private readonly listTemplatesUseCase: ListTemplatesUseCase,
    private readonly scaffoldTemplateUseCase: ScaffoldTemplateUseCase,
    @Optional()
    private readonly convertDocumentUseCase?: ConvertDocumentUseCase,
  ) {}

  public async exportProjectZip(
    projectId: string,
    query?: ExportZipQueryDto,
  ): Promise<ExportProjectZipOutput> {
    return await this.exportProjectZipUseCase.execute({
      projectId,
      projectName: query?.projectName,
      includePdf: query?.includePdf,
      cleanArxiv: query?.cleanArxiv,
    });
  }

  public async importProjectZip(
    projectId: string,
    zipBuffer: Buffer,
    userId?: string | null,
    preferredRootDoc?: string,
  ): Promise<ImportSummaryResponseDto> {
    const summary = await this.importProjectZipUseCase.execute({
      projectId,
      zipBuffer,
      userId,
      preferredRootDoc,
    });
    return summary.toJSON() as ImportSummaryResponseDto;
  }

  public async listTemplates(): Promise<TemplateResponseDto[]> {
    const templates = await this.listTemplatesUseCase.execute();
    return templates.map((t) => t.toJSON() as TemplateResponseDto);
  }

  public async getTemplate(
    templateId: string,
  ): Promise<TemplateResponseDto | null> {
    const templates = await this.listTemplatesUseCase.execute();
    const found = templates.find((t) => t.id === templateId);
    return found ? (found.toJSON() as TemplateResponseDto) : null;
  }

  public async scaffoldTemplate(
    projectId: string,
    templateId: string,
    userId?: string | null,
  ): Promise<ImportSummaryResponseDto> {
    const summary = await this.scaffoldTemplateUseCase.execute({
      projectId,
      templateId,
      userId,
    });
    return summary.toJSON() as ImportSummaryResponseDto;
  }

  public async convertDocument(
    input: ConvertDocumentInput,
  ): Promise<ImportSummaryResponseDto> {
    if (!this.convertDocumentUseCase) {
      throw new Error('ConvertDocumentUseCase is not available');
    }
    const summary = await this.convertDocumentUseCase.execute(input);
    return summary.toJSON() as ImportSummaryResponseDto;
  }
}
