import { IsArray, IsString, IsOptional } from 'class-validator';

export class MoveItemsDto {
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  itemIds?: string[];

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  paperIds?: string[];
}
