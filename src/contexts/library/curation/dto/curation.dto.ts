import { IsString, IsArray, IsOptional } from 'class-validator';

export class MergeDuplicatesDto {
  @IsString()
  primaryItemId!: string;

  @IsArray()
  duplicateItemIds!: string[];

  @IsOptional()
  mergedData?: Record<string, any>;
}

export class DuplicateClusterResult {
  clusterId!: string;
  matchReason!: string;
  confidence!: number;
  items!: Array<{
    id: string;
    title: string;
    doi?: string;
    year?: number;
    authors?: string[];
  }>;
}
