import { IsEnum, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export enum DocumentExportFormat {
  PDF = 'pdf',
  MARKDOWN = 'markdown',
  LATEX_SOURCE = 'latex-source',
  LATEX_BUNDLE = 'latex-bundle',
  LATEX_SOURCE_UNDERSCORE = 'latex_source',
  LATEX_BUNDLE_UNDERSCORE = 'latex_bundle',
  ZIP = 'zip',
  ARXIV_ZIP = 'arxiv-zip',
  ARXIV_ZIP_UNDERSCORE = 'arxiv_zip',
  LOG = 'log',
  BBL = 'bbl',
  AUX = 'aux',
}

export class ExportDocumentDto {
  @ApiProperty({
    enum: DocumentExportFormat,
    description: 'Target export format',
    default: DocumentExportFormat.PDF,
  })
  @IsEnum(DocumentExportFormat)
  format!: DocumentExportFormat;

  @ApiPropertyOptional({
    description: 'Whether to include child sub-sections',
    default: true,
  })
  @IsOptional()
  includeChildren?: boolean;
}
