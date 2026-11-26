import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsBoolean,
  IsOptional,
  IsInt,
  Min,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';

export class ExportZipQueryDto {
  @ApiPropertyOptional({
    description: 'Include latest compiled output.pdf in the archive package',
    default: false,
  })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  includePdf?: boolean;

  @ApiPropertyOptional({
    description:
      'Filter files strictly for arXiv submission (strip aux, log, out, synctex and include bbl)',
    default: false,
  })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  cleanArxiv?: boolean;

  @ApiPropertyOptional({
    description: 'Export mode (e.g. "arxiv" or "standard")',
  })
  @IsOptional()
  @IsString()
  mode?: string;

  @ApiPropertyOptional({
    description: 'Optional historical version number to export as ZIP',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  version?: number;

  @ApiPropertyOptional({ description: 'Custom archive file name' })
  @IsOptional()
  @IsString()
  projectName?: string;

  @ApiPropertyOptional({ description: 'Optional Page scope ID' })
  @IsOptional()
  @IsString()
  pageId?: string;
}

export class ExportDocumentDto {
  @ApiPropertyOptional({
    description: 'Target export format (tex, md, html, docx)',
  })
  @IsOptional()
  @IsString()
  format?: string;

  @ApiPropertyOptional({
    description: 'Inline child \\input / \\include / \\subfile files',
  })
  @IsOptional()
  includeChildren?: boolean | string;
}
