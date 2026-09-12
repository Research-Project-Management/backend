import { IsString, IsOptional, IsInt, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';

export class LibraryFilterDto {
  @IsOptional()
  @IsString()
  query?: string;

  @IsOptional()
  @IsString()
  itemType?: string;

  @IsOptional()
  @IsString()
  collectionId?: string;

  @IsOptional()
  @IsString()
  tagId?: string;
}

export class LibraryPaginationDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}

export class LibraryStatsResponseDto {
  itemsCount!: number;
  collectionsCount!: number;
  tagsCount!: number;
  notesCount!: number;
  attachmentsCount!: number;
  storageBytes?: number;
}

export class LibraryOverviewResponseDto {
  recentItems!: any[];
  unfiledCount!: number;
  trashCount!: number;
  starredCount!: number;
  topTags!: Array<{ id: string; name: string; color?: string | null; count: number }>;
}

export const CoreFilterDto = LibraryFilterDto;
export type CoreFilterDto = LibraryFilterDto;

export const CorePaginationDto = LibraryPaginationDto;
export type CorePaginationDto = LibraryPaginationDto;

export const CoreStatsResponseDto = LibraryStatsResponseDto;
export type CoreStatsResponseDto = LibraryStatsResponseDto;

export const CoreOverviewResponseDto = LibraryOverviewResponseDto;
export type CoreOverviewResponseDto = LibraryOverviewResponseDto;
