import { IsString, IsArray, IsOptional } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class MergeCatalogItemsDto {
  @ApiPropertyOptional({
    description:
      'The master catalog item ID that will retain all merged data and attachments',
  })
  @IsString()
  @IsOptional()
  masterId?: string;

  @ApiPropertyOptional({
    description: 'Legacy alias for masterId',
  })
  @IsString()
  @IsOptional()
  masterPaperId?: string;

  @ApiPropertyOptional({
    description:
      'Array of catalog item IDs to be merged into master and soft-deleted',
    type: [String],
  })
  @IsArray()
  @IsOptional()
  sourceItemIds?: string[];

  @ApiPropertyOptional({
    description: 'Legacy alias for sourceItemIds',
    type: [String],
  })
  @IsArray()
  @IsOptional()
  sourcePaperIds?: string[];
}

// Backward compatibility alias
export const MergePapersDto = MergeCatalogItemsDto;
export type MergePapersDto = MergeCatalogItemsDto;
export const MergeItemsDto = MergeCatalogItemsDto;
export type MergeItemsDto = MergeCatalogItemsDto;

export interface DuplicateGroupItem {
  id: string;
  title: string;
  doi?: string;
  authors: string[];
  year: number | null;
  citationKey: string;
  collectionId: string | null;
  createdAt: Date;
  attachmentsCount: number;
}

export interface DuplicateGroup {
  matchType: 'DOI' | 'TITLE_AUTHOR_YEAR';
  confidence: 'high' | 'medium';
  matchKey: string;
  items: DuplicateGroupItem[];
  papers?: DuplicateGroupItem[]; // compatibility alias
}

export interface IntegrityIssue {
  itemId: string;
  paperId?: string; // compatibility alias
  title: string;
  citationKey: string;
  issues: string[];
}

export interface IntegrityReport {
  totalItems: number;
  healthyItems: number;
  totalPapers?: number; // compatibility alias
  healthyPapers?: number; // compatibility alias
  missingDoiCount: number;
  missingYearCount: number;
  missingAuthorsCount: number;
  missingPdfCount: number;
  flaggedItems: IntegrityIssue[];
}
