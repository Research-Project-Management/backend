/**
 * templates/dto/template.dto.ts
 * Validated HTTP DTOs for Gallery Browse, Publish, Update, and Workspace Scaffold.
 */

import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  TEMPLATE_CATEGORIES,
  TEMPLATE_COMPILERS,
  TEMPLATE_VISIBILITIES,
  TemplateCategory,
  TemplateCompiler,
  TemplateVisibility,
} from '../domain/policy';

export class QueryTemplatesDto {
  @IsOptional()
  @IsIn(TEMPLATE_CATEGORIES)
  category?: TemplateCategory;

  @IsOptional()
  @IsIn(TEMPLATE_VISIBILITIES)
  visibility?: TemplateVisibility;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  tag?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;

  @IsOptional()
  @IsUUID()
  spaceId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}

export class PublishTemplateDto {
  @IsString()
  @MaxLength(255)
  name!: string;

  @IsOptional()
  @IsIn(TEMPLATE_CATEGORIES)
  category?: TemplateCategory;

  @IsOptional()
  @IsIn(TEMPLATE_VISIBILITIES)
  visibility?: TemplateVisibility;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsIn(TEMPLATE_COMPILERS)
  compiler?: TemplateCompiler;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  texLiveVersion?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  mainFile?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  author?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  license?: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  sourceUrl?: string;

  @IsOptional()
  @IsString()
  thumbnailUrl?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  /** Optional inline text files (`{ "main.tex": "..." }`) when not snapshotting a live page. */
  @IsOptional()
  @IsObject()
  files?: Record<string, string>;

  /** Source workspace Space ID to snapshot text + binary files from. */
  @IsOptional()
  @IsUUID()
  spaceId?: string;

  /** Source manuscript Page ID to snapshot text + binary files from. */
  @IsOptional()
  @IsUUID()
  pageId?: string;
}

export class UpdateTemplateDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @IsOptional()
  @IsIn(TEMPLATE_CATEGORIES)
  category?: TemplateCategory;

  @IsOptional()
  @IsIn(TEMPLATE_VISIBILITIES)
  visibility?: TemplateVisibility;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsIn(TEMPLATE_COMPILERS)
  compiler?: TemplateCompiler;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  mainFile?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  license?: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  sourceUrl?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsUUID()
  spaceId?: string;

  @IsOptional()
  @IsUUID()
  pageId?: string;
}

export class ScaffoldTemplateDto {
  @IsOptional()
  @IsUUID()
  pageId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;
}
