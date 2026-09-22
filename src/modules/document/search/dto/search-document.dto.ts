import {
  IsString,
  IsOptional,
  IsBoolean,
  IsArray,
  IsInt,
  Min,
  Max,
  IsNotEmpty,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SearchDocumentQueryDto {
  @ApiProperty({ description: 'Search term or regular expression pattern' })
  @IsString()
  @IsNotEmpty()
  query!: string;

  @ApiPropertyOptional({
    description: 'Case sensitive matching',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === 'true' || value === true)
  caseSensitive?: boolean = false;

  @ApiPropertyOptional({
    description: 'Whole word matching',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === 'true' || value === true)
  wholeWord?: boolean = false;

  @ApiPropertyOptional({
    description: 'Treat query as a regular expression',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === 'true' || value === true)
  useRegex?: boolean = false;

  @ApiPropertyOptional({
    description: 'Filter search to specific file / page IDs',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  fileIds?: string[];

  @ApiPropertyOptional({
    description: 'Maximum matches to return across all documents',
    default: 500,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(2000)
  @Type(() => Number)
  maxResults?: number = 500;
}

export class BatchReplaceDocumentDto {
  @ApiProperty({ description: 'Search term or regular expression pattern' })
  @IsString()
  @IsNotEmpty()
  query!: string;

  @ApiProperty({ description: 'Replacement string' })
  @IsString()
  replaceWith!: string;

  @ApiPropertyOptional({
    description: 'Case sensitive matching',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === 'true' || value === true)
  caseSensitive?: boolean = false;

  @ApiPropertyOptional({
    description: 'Whole word matching',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === 'true' || value === true)
  wholeWord?: boolean = false;

  @ApiPropertyOptional({
    description: 'Treat query as a regular expression',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === 'true' || value === true)
  useRegex?: boolean = false;

  @ApiPropertyOptional({
    description: 'Target specific file / page IDs for replacement',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  fileIds?: string[];
}

export interface SearchMatchEntry {
  line: number;
  text: string;
  matchStart: number;
  matchEnd: number;
  snippet: string;
}

export interface FileSearchResult {
  fileId: string;
  fileName: string;
  isMainFile: boolean;
  totalMatches: number;
  matches: SearchMatchEntry[];
}

export interface SearchResultResponse {
  query: string;
  totalFiles: number;
  totalMatches: number;
  results: FileSearchResult[];
  truncated: boolean;
}

export interface BatchReplaceResultResponse {
  query: string;
  replaceWith: string;
  totalFilesAffected: number;
  totalOccurrencesReplaced: number;
  affectedFileIds: string[];
}
