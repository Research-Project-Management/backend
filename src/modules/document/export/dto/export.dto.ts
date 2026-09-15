import { IsEnum, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export enum DocumentExportFormat {
  PDF = 'pdf',
  MARKDOWN = 'markdown',
  LATEX_SOURCE = 'latex-source',
  LATEX_BUNDLE = 'latex-bundle',
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
