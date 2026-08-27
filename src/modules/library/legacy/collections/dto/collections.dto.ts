import {
  IsNotEmpty,
  IsOptional,
  IsString,
  IsArray,
  IsIn,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateCollectionDto {
  @ApiProperty({ description: 'Display name of the collection' })
  @IsString()
  @IsNotEmpty({ message: 'Collection name is required' })
  name!: string;

  @ApiPropertyOptional({
    description: 'Optional description for the collection',
  })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({
    description: 'Hex or theme color code (e.g. #3370ff)',
  })
  @IsString()
  @IsOptional()
  color?: string;

  @ApiPropertyOptional({ description: 'Icon identifier string' })
  @IsString()
  @IsOptional()
  icon?: string;

  @ApiPropertyOptional({
    description: 'Parent collection ID for nested hierarchy',
  })
  @IsString()
  @IsOptional()
  parentId?: string;

  @ApiPropertyOptional({ description: 'Legacy alias for parentId' })
  @IsString()
  @IsOptional()
  parent?: string;
}

export class UpdateCollectionDto {
  @ApiPropertyOptional({ description: 'Updated collection name' })
  @IsString()
  @IsOptional()
  name?: string;

  @ApiPropertyOptional({ description: 'Updated description' })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({ description: 'Updated color' })
  @IsString()
  @IsOptional()
  color?: string;

  @ApiPropertyOptional({ description: 'Updated icon' })
  @IsString()
  @IsOptional()
  icon?: string;

  @ApiPropertyOptional({ description: 'Updated parent collection ID' })
  @IsString()
  @IsOptional()
  parentId?: string;

  @ApiPropertyOptional({ description: 'Legacy alias for parentId' })
  @IsString()
  @IsOptional()
  parent?: string;
}

export class MoveItemsDto {
  @ApiPropertyOptional({
    description: 'Array of library item IDs to move',
    type: [String],
  })
  @IsArray()
  @IsOptional()
  itemIds?: string[];

  @ApiPropertyOptional({
    description: 'Compatibility alias for itemIds',
    type: [String],
  })
  @IsArray()
  @IsOptional()
  paperIds?: string[];
}

export class ReorderItemDto {
  @ApiProperty({ description: 'Collection ID to reparent or reorder' })
  @IsString()
  @IsNotEmpty()
  id!: string;

  @ApiPropertyOptional({
    description: 'New parent collection ID or null for root',
  })
  @IsString()
  @IsOptional()
  parentId?: string | null;
}

export class ReorderCollectionsDto {
  @ApiProperty({
    description: 'Array of collections with their target parent hierarchy',
    type: [ReorderItemDto],
  })
  @IsNotEmpty({ message: 'collections array is required' })
  collections!: ReorderItemDto[];
}

export class DeleteCollectionQueryDto {
  @ApiPropertyOptional({
    description: 'Strategy for handling child collections and items',
    enum: ['cascade', 'move-to-parent', 'orphan'],
    default: 'cascade',
  })
  @IsString()
  @IsOptional()
  @IsIn(['cascade', 'move-to-parent', 'orphan'])
  strategy?: 'cascade' | 'move-to-parent' | 'orphan';
}

export class AssignItemsToCollectionDto {
  @ApiPropertyOptional({
    description: 'Array of library item IDs to link to collection',
    type: [String],
  })
  @IsArray()
  @IsOptional()
  itemIds?: string[];

  @ApiPropertyOptional({
    description: 'Compatibility alias for itemIds',
    type: [String],
  })
  @IsArray()
  @IsOptional()
  paperIds?: string[];
}

// Aliases for compatibility
export const MovePapersDto = MoveItemsDto;
export type MovePapersDto = MoveItemsDto;

export const AssignPapersToCollectionDto = AssignItemsToCollectionDto;
export type AssignPapersToCollectionDto = AssignItemsToCollectionDto;
