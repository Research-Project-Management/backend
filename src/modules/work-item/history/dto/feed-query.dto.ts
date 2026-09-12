import { IsEnum, IsOptional, IsInt, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

export enum CollaborationTab {
  ALL = 'all',
  ACTIVITY = 'activity',
  COMMENTS = 'comments',
  TRANSITION = 'transition',
  HISTORY = 'history',
  WORKLOGS = 'worklogs',
}

export enum FeedSortOrder {
  ASC = 'asc',
  DESC = 'desc',
}

export class FeedQueryDto {
  @ApiPropertyOptional({
    enum: CollaborationTab,
    default: CollaborationTab.ALL,
    description: 'Collaboration tab: all, activity, comments, transition, history, worklogs',
  })
  @IsOptional()
  @IsEnum(CollaborationTab)
  tab?: CollaborationTab = CollaborationTab.ALL;

  @ApiPropertyOptional({
    enum: FeedSortOrder,
    default: FeedSortOrder.DESC,
    description: 'Sort order: desc (newest-first, default in Plane) or asc (oldest-first)',
  })
  @IsOptional()
  @IsEnum(FeedSortOrder)
  sort?: FeedSortOrder = FeedSortOrder.DESC;

  @ApiPropertyOptional({ default: 1, description: 'Page number' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 50, description: 'Items per page' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number = 50;
}
