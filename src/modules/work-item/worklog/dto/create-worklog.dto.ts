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
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';

export class CreateWorklogDto {
  @ApiProperty({
    description: 'Hours worked (e.g. 2 or 1.5)',
    example: 2,
    minimum: 0,
    maximum: 24,
  })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(24)
  hours!: number;

  @ApiPropertyOptional({
    description: 'Additional minutes worked (0-59)',
    example: 30,
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
    description: 'Description of the work performed',
    example: 'Implemented authentication endpoints and JWT verification',
    maxLength: 1000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiPropertyOptional({
    description: 'Date the work was performed (ISO string, defaults to now)',
    example: '2026-09-12T10:00:00.000Z',
  })
  @IsOptional()
  @IsDateString()
  date?: string;
}
