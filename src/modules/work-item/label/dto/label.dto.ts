import {
  IsArray,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { LabelType } from '@prisma/client';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// ── Project-Scoped DTOs ───────────────────────────────────────────────────────

export class CreateProjectLabelDto {
  @ApiProperty({
    description: 'Label name (unique within project)',
    example: 'Bug',
  })
  @IsString()
  @IsNotEmpty({ message: 'Label name is required' })
  @MaxLength(255)
  name!: string;

  @ApiPropertyOptional({
    description: 'Hex color code (e.g. #ef4444)',
    example: '#ef4444',
  })
  @IsString()
  @IsOptional()
  @Matches(/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/, {
    message: 'Color must be a valid hex color code (e.g. #ef4444 or #f00)',
  })
  color?: string;

  @ApiPropertyOptional({
    description: 'Description / guidelines for using this label',
  })
  @IsString()
  @IsOptional()
  @MaxLength(1000)
  description?: string;

  @ApiPropertyOptional({
    description: 'Parent label UUID for hierarchical sub-labels',
  })
  @IsUUID()
  @IsOptional()
  parentId?: string;

  @ApiPropertyOptional({
    description: 'Display sort order rank',
    example: 10000,
  })
  @IsNumber()
  @IsOptional()
  sortOrder?: number;
}

export class UpdateProjectLabelDto {
  @ApiPropertyOptional({
    description: 'Updated label name',
    example: 'Critical Bug',
  })
  @IsString()
  @IsOptional()
  @MaxLength(255)
  name?: string;

  @ApiPropertyOptional({
    description: 'Updated hex color code',
    example: '#dc2626',
  })
  @IsString()
  @IsOptional()
  @Matches(/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/, {
    message: 'Color must be a valid hex color code (e.g. #ef4444)',
  })
  color?: string;

  @ApiPropertyOptional({ description: 'Updated description' })
  @IsString()
  @IsOptional()
  @MaxLength(1000)
  description?: string;

  @ApiPropertyOptional({
    description: 'Parent label UUID or null to detach hierarchy',
  })
  @IsOptional()
  parentId?: string | null;

  @ApiPropertyOptional({ description: 'Updated sort order' })
  @IsNumber()
  @IsOptional()
  sortOrder?: number;
}

export class ReorderLabelItemDto {
  @ApiProperty({ description: 'Label UUID' })
  @IsUUID()
  id!: string;

  @ApiProperty({ description: 'New sort order' })
  @IsNumber()
  sortOrder!: number;
}

export class ReorderLabelsDto {
  @ApiProperty({
    type: [ReorderLabelItemDto],
    description: 'List of label IDs and their new sort orders',
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReorderLabelItemDto)
  labels!: ReorderLabelItemDto[];
}

export class ImportLabelItemDto {
  @ApiProperty({ description: 'Label name', example: 'Frontend' })
  @IsString()
  @IsNotEmpty({ message: 'Label name is required' })
  @MaxLength(255)
  name!: string;

  @ApiPropertyOptional({ description: 'Hex color code', example: '#3b82f6' })
  @IsString()
  @IsOptional()
  color?: string;

  @ApiPropertyOptional({ description: 'Label description' })
  @IsString()
  @IsOptional()
  @MaxLength(1000)
  description?: string;
}

export class ImportLabelsDto {
  @ApiProperty({
    type: [ImportLabelItemDto],
    description: 'Array of labels to import into project',
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ImportLabelItemDto)
  labels!: ImportLabelItemDto[];
}

// ── Legacy DTOs (Preserved for 100% Backward Compatibility) ───────────────────

export class QueryLabelDto {
  @ApiPropertyOptional({ enum: LabelType })
  @IsEnum(LabelType)
  @IsOptional()
  type?: LabelType;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  projectId?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  workspaceId?: string;
}

export class CreateLabelDto {
  @ApiProperty({ description: 'Label name' })
  @IsString()
  @IsNotEmpty({ message: 'Label name is required' })
  name!: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  color?: string;

  @ApiPropertyOptional({ enum: LabelType })
  @IsEnum(LabelType)
  @IsOptional()
  type?: LabelType;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  projectId?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  workspaceId?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  description?: string;

  @ApiPropertyOptional()
  @IsUUID()
  @IsOptional()
  parentId?: string;
}

export class UpdateLabelDto {
  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  name?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  color?: string;

  @ApiPropertyOptional({ enum: LabelType })
  @IsEnum(LabelType)
  @IsOptional()
  type?: LabelType;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  parentId?: string | null;

  @ApiPropertyOptional()
  @IsNumber()
  @IsOptional()
  sortOrder?: number;
}
