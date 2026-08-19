import { IsString, IsArray, IsNotEmpty, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class MergePapersDto {
  @ApiProperty({
    description: 'The master paper ID that will retain all merged data and attachments',
  })
  @IsString()
  @IsNotEmpty()
  masterPaperId!: string;

  @ApiProperty({
    description: 'Array of paper IDs to be merged into master and soft-deleted',
    type: [String],
  })
  @IsArray()
  @IsNotEmpty()
  sourcePaperIds!: string[];
}

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
  papers: DuplicateGroupItem[];
}

export interface IntegrityIssue {
  paperId: string;
  title: string;
  citationKey: string;
  issues: string[];
}

export interface IntegrityReport {
  totalPapers: number;
  healthyPapers: number;
  missingDoiCount: number;
  missingYearCount: number;
  missingAuthorsCount: number;
  missingPdfCount: number;
  flaggedItems: IntegrityIssue[];
}
