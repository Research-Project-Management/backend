import { IsString, IsOptional, IsBoolean } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ExtractOutlineDto {
  @ApiPropertyOptional({ description: 'Raw LaTeX or Markdown text source' })
  @IsString()
  @IsOptional()
  source?: string;

  @ApiPropertyOptional({
    description:
      'Whether to include child sub-sections/sub-files in extraction',
    default: true,
  })
  @IsBoolean()
  @IsOptional()
  includeChildren?: boolean;
}

export interface OutlineItem {
  id: string;
  level: number;
  levelName: string;
  title: string;
  line: number;
  file?: string;
  pageId?: string;
  children?: OutlineItem[];
}
