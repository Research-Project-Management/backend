import { IsArray, IsString, IsOptional, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

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
