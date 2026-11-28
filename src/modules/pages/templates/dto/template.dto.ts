/**
 * templates/dto/template.dto.ts
 * Standardized HTTP DTOs for Pages Template Gallery Browse, Publish, Metadata Update, and Instantiate.
 */

import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  TEMPLATE_CATEGORIES,
  TEMPLATE_SCOPES,
  TemplateCategory,
  TemplateScope,
} from '../domain/policy';

export class QueryTemplatesDto {
  @IsOptional()
  @IsIn(TEMPLATE_CATEGORIES)
  category?: TemplateCategory;

  @IsOptional()
  @IsIn(TEMPLATE_SCOPES)
  scope?: TemplateScope;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
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
  /** Source Page ID to snapshot text documents and FileBlob references from. */
  @IsUUID()
  pageId!: string;

  @IsString()
  @MaxLength(255)
  name!: string;

  @IsOptional()
  @IsIn(TEMPLATE_CATEGORIES)
  category?: TemplateCategory;

  /** Target Space scope (`personal` | `project`). */
  @IsOptional()
  @IsIn(TEMPLATE_SCOPES)
  scope?: TemplateScope;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];
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
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];
}

export class InstantiateTemplateDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;
}
