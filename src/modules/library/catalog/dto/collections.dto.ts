import {
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
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
  projectId?: string | null;
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
  expectedVersion?: number;

  @IsOptional()
  version?: number;
}

export class AssignItemsToCollectionDto {
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  itemIds?: string[];
}

export class MoveItemsDto {
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  itemIds?: string[];
}

export class ReorderCollectionItemDto {
  @IsString()
  id!: string;

  @IsString()
  @IsOptional()
  parentId?: string | null;

  @IsOptional()
  orderIndex?: number;
}

export class ReorderCollectionsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReorderCollectionItemDto)
  collections!: ReorderCollectionItemDto[];
}

export class BulkDetachItemsDto {
  @IsArray()
  @IsString({ each: true })
  itemIds!: string[];
}
