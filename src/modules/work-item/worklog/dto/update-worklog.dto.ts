import {
  IsNumber,
  IsInt,
  IsOptional,
  IsString,
  IsDateString,
  Min,
  Max,
  MaxLength,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';

export class UpdateWorklogDto {
  @ApiPropertyOptional({
    description: 'Updated hours worked',
    example: 3,
    minimum: 0,
    maximum: 24,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(24)
  hours?: number;

  @ApiPropertyOptional({
    description: 'Updated additional minutes worked (0-59)',
    example: 15,
    minimum: 0,
    maximum: 59,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(59)
  minutes?: number;

  @ApiPropertyOptional({
    description: 'Updated description of work performed',
    example: 'Refactored error handling and updated unit tests',
    maxLength: 1000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiPropertyOptional({
    description: 'Updated date the work was performed (ISO string)',
    example: '2026-09-12T14:30:00.000Z',
  })
  @IsOptional()
  @IsDateString()
  date?: string;
}
