import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateCollectionDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name!: string;

  @IsString()
  @IsOptional()
  @MaxLength(1000)
  description?: string;

  @IsString()
  @IsOptional()
  @MaxLength(50)
  color?: string;

  @IsString()
  @IsOptional()
  @MaxLength(50)
  icon?: string;

  @IsOptional()
  @ValidateIf(
    (o: { parentId?: string | null }) =>
      o.parentId !== null &&
      o.parentId !== undefined &&
      o.parentId !== '' &&
      o.parentId !== 'root',
  )
  @IsUUID()
  parentId?: string | null;

  @IsOptional()
  @IsUUID()
  spaceId?: string | null;
}

export class UpdateCollectionDto {
  @IsString()
  @IsOptional()
  @MaxLength(255)
  name?: string;

  @IsString()
  @IsOptional()
  @MaxLength(1000)
  description?: string;

  @IsString()
  @IsOptional()
  @MaxLength(50)
  color?: string;

  @IsString()
  @IsOptional()
  @MaxLength(50)
  icon?: string;

  @IsOptional()
  @ValidateIf(
    (o: { parentId?: string | null }) =>
      o.parentId !== null &&
      o.parentId !== undefined &&
      o.parentId !== '' &&
      o.parentId !== 'root',
  )
  @IsUUID()
  parentId?: string | null;

  @IsOptional()
  @IsInt()
  expectedVersion?: number;

  @IsOptional()
  @IsInt()
  version?: number;
}

export class AssignItemsToCollectionDto {
  @IsArray()
  @ArrayMaxSize(500)
  @IsUUID('all', { each: true })
  @IsOptional()
  itemIds?: string[];
}

export class MoveItemsDto {
  @IsArray()
  @ArrayMaxSize(500)
  @IsUUID('all', { each: true })
  @IsOptional()
  itemIds?: string[];

  @IsOptional()
  @ValidateIf(
    (o: { sourceCollectionId?: string | null }) =>
      o.sourceCollectionId !== null &&
      o.sourceCollectionId !== undefined &&
      o.sourceCollectionId !== '' &&
      o.sourceCollectionId !== 'unfiled' &&
      o.sourceCollectionId !== 'root',
  )
  @IsUUID()
  sourceCollectionId?: string | null;
}

class ReorderCollectionItemDto {
  @IsUUID()
  id!: string;

  @IsOptional()
  @ValidateIf(
    (o: { parentId?: string | null }) =>
      o.parentId !== null &&
      o.parentId !== undefined &&
      o.parentId !== '' &&
      o.parentId !== 'root',
  )
  @IsUUID()
  parentId?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  orderIndex?: number;
}

export class ReorderCollectionsDto {
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ReorderCollectionItemDto)
  collections!: ReorderCollectionItemDto[];
}

export class BulkDetachItemsDto {
  @IsArray()
  @ArrayMaxSize(500)
  @IsUUID('all', { each: true })
  itemIds!: string[];
}

export class CopyCollectionDto {
  @IsOptional()
  @ValidateIf(
    (o: { parentId?: string | null }) =>
      o.parentId !== null &&
      o.parentId !== undefined &&
      o.parentId !== '' &&
      o.parentId !== 'root',
  )
  @IsUUID()
  parentId?: string | null;

  @IsOptional()
  @IsUUID()
  spaceId?: string | null;
}
