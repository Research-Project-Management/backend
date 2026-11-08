import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsOptional, IsString } from 'class-validator';
import { ProjectResponseDto } from '../../core/dto/response.dto';
import {
  ArchivedPageSummary,
  ArchivedWorkItemSummary,
} from '../types/archive.types';

export { ProjectResponseDto };

export class QueryProjectArchivesDto {
  @ApiPropertyOptional({
    description: 'Search filter across archived work items and pages',
  })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({
    description: 'Optional entity filter (all | work-items | pages)',
  })
  @IsOptional()
  @IsString()
  type?: 'all' | 'work-items' | 'pages';
}

export class BulkRestoreProjectArchivesDto {
  @ApiPropertyOptional({
    description: 'Work item UUIDs to restore within the project',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  workItemIds?: string[];

  @ApiPropertyOptional({
    description: 'Alias for workItemIds',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  ids?: string[];

  @ApiPropertyOptional({
    description: 'Page document UUIDs to restore to published status',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  pageIds?: string[];
}

export class ProjectScopedArchivesResponseDto {
  @ApiProperty()
  projectId!: string;

  @ApiProperty({ type: [Object] })
  workItems!: ArchivedWorkItemSummary[];

  @ApiProperty({ type: [Object] })
  pages!: ArchivedPageSummary[];

  @ApiProperty()
  counts!: {
    workItems: number;
    pages: number;
    total: number;
  };
}
