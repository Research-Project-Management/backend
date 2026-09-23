/**
 * modules/manuscripts/structure/dto/node.dto.ts
 * Data Transfer Objects for Manuscript Structure API.
 */

import { IsString, IsNotEmpty, IsOptional, IsEnum, IsBoolean, IsInt, IsUUID } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateNodeDto {
  @ApiProperty({ description: 'Leaf name of file or folder (e.g. intro.tex or figures)' })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiPropertyOptional({ description: 'Explicit full path (e.g. /chapters/intro.tex)' })
  @IsString()
  @IsOptional()
  path?: string;

  @ApiPropertyOptional({ description: 'Parent folder UUID' })
  @IsUUID()
  @IsOptional()
  parentId?: string | null;

  @ApiProperty({ enum: ['FOLDER', 'DOC', 'FILE'], default: 'DOC' })
  @IsEnum(['FOLDER', 'DOC', 'FILE'])
  type!: 'FOLDER' | 'DOC' | 'FILE';

  @ApiPropertyOptional({ description: 'Linked Docstore text document UUID' })
  @IsUUID()
  @IsOptional()
  docId?: string | null;

  @ApiPropertyOptional({ description: 'Linked Filestore binary file UUID' })
  @IsUUID()
  @IsOptional()
  fileId?: string | null;

  @ApiPropertyOptional({ description: 'Set as primary compilation entrypoint (main.tex)' })
  @IsBoolean()
  @IsOptional()
  isRootDoc?: boolean;
}

export class MoveNodeDto {
  @ApiPropertyOptional({ description: 'Target destination parent folder UUID' })
  @IsUUID()
  @IsOptional()
  destParentId?: string | null;

  @ApiPropertyOptional({ description: 'Target destination virtual path (e.g. /archive/intro.tex)' })
  @IsString()
  @IsOptional()
  destPath?: string;
}

export class RenameNodeDto {
  @ApiProperty({ description: 'New leaf name of file or folder' })
  @IsString()
  @IsNotEmpty()
  name!: string;
}

export class ReorderNodeDto {
  @ApiProperty({ description: 'Integer sort index for display' })
  @IsInt()
  sortOrder!: number;
}

export class TreeNodeDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  path!: string;

  @ApiProperty({ enum: ['FOLDER', 'DOC', 'FILE'] })
  type!: 'FOLDER' | 'DOC' | 'FILE';

  @ApiProperty()
  depth!: number;

  @ApiProperty()
  isRootDoc!: boolean;

  @ApiPropertyOptional()
  docId?: string | null;

  @ApiPropertyOptional()
  fileId?: string | null;

  @ApiProperty()
  sizeBytes!: number;

  @ApiPropertyOptional()
  hash?: string | null;

  @ApiProperty()
  sortOrder!: number;

  @ApiProperty({ type: [TreeNodeDto] })
  children!: TreeNodeDto[];
}
