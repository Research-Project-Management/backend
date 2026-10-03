import { IsOptional, IsString, IsInt, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class QueryDraftDto {
  @ApiPropertyOptional({ description: 'Filter drafts by project ID' })
  @IsOptional()
  @IsString()
  projectId?: string;

  @ApiPropertyOptional({ description: 'Search term in draft title' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number = 50;

  @ApiPropertyOptional({
    description: 'Force empty response for UI preview/testing',
  })
  @IsOptional()
  @IsString()
  forceEmpty?: string;

  @ApiPropertyOptional({
    description: 'Simulate server error for testing error states',
  })
  @IsOptional()
  @IsString()
  forceError?: string;
}
