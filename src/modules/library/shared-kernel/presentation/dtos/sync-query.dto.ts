import { IsOptional, IsString, IsInt, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class SyncQueryDto {
  @ApiPropertyOptional({
    description: 'Fetch changes or tombstones with sequence strictly greater than this value',
    default: '0',
    example: '100',
  })
  @IsOptional()
  @IsString()
  since?: string;

  @ApiPropertyOptional({
    description: 'Maximum number of delta records to return (1-500)',
    default: 100,
    example: 100,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number = 100;
}
