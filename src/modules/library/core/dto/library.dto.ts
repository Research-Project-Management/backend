import { IsString, IsOptional, IsInt, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
import { RecentLibraryItem } from '../types/library.types';

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

export class LibraryPermissionsDto {
  canCreate!: boolean;
  canEdit!: boolean;
  canDelete!: boolean;
  canManageCollections!: boolean;
}

export class LibraryOverviewResponseDto {
  recentItems!: RecentLibraryItem[];
  unfiledCount!: number;
  trashCount!: number;
  starredCount!: number;
  duplicateCount!: number;
  myPublicationsCount!: number;
  permissions!: LibraryPermissionsDto;
  topTags!: Array<{
    id: string;
    name: string;
    color?: string | null;
    count: number;
  }>;
}
