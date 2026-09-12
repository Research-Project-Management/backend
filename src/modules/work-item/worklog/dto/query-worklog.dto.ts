import { IsOptional, IsString, IsDateString, IsInt, Min, Max } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';

export class QueryWorklogDto {
  @ApiPropertyOptional({
    description: 'Filter logs starting from this date (ISO string)',
    example: '2026-09-01T00:00:00.000Z',
  })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional({
    description: 'Filter logs up to this date (ISO string)',
    example: '2026-09-30T23:59:59.999Z',
  })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiPropertyOptional({
    description: 'Filter logs by author user ID',
    example: '11111111-1111-1111-1111-111111111111',
  })
  @IsOptional()
  @IsString()
  userId?: string;

  @ApiPropertyOptional({
    description: 'Filter logs by project ID or identifier',
    example: 'FLUX',
  })
  @IsOptional()
  @IsString()
  projectId?: string;

  @ApiPropertyOptional({
    description: 'Page number for pagination',
    default: 1,
    example: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({
    description: 'Items per page',
    default: 50,
    example: 50,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}
