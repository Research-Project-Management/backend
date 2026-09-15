import { IsString, IsOptional, IsBoolean } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateTemplateDto {
  @ApiProperty({ description: 'Template name' })
  @IsString()
  name!: string;

  @ApiPropertyOptional({ description: 'Template slug identifier' })
  @IsString()
  @IsOptional()
  slug?: string;

  @ApiPropertyOptional({ description: 'Template description' })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({
    description: 'Category: conference, journal, thesis, presentation, report',
  })
  @IsString()
  @IsOptional()
  category?: string;

  @ApiPropertyOptional({ description: 'Thumbnail URL' })
  @IsString()
  @IsOptional()
  thumbnail?: string;

  @ApiPropertyOptional({
    description: 'Default root document content (rich-text JSON or LaTeX)',
  })
  @IsOptional()
  content?: unknown;

  @ApiPropertyOptional({
    description:
      'Map of filenames to source content, e.g. { "main.tex": "...", "references.bib": "..." }',
  })
  @IsOptional()
  files?: Record<string, string>;

  @ApiPropertyOptional({
    description: 'Flag whether template is system built-in',
  })
  @IsBoolean()
  @IsOptional()
  isSystem?: boolean;
}

export class ApplyTemplateDto {
  @ApiPropertyOptional({
    description: 'Custom title for the new root document',
  })
  @IsString()
  @IsOptional()
  title?: string;
}

export class SaveAsTemplateDto {
  @ApiProperty({ description: 'Name for the saved template' })
  @IsString()
  name!: string;

  @ApiPropertyOptional({ description: 'Description of the template' })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({
    description: 'Category (conference, journal, thesis, etc.)',
    default: 'custom',
  })
  @IsString()
  @IsOptional()
  category?: string;
}
