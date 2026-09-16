import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsInt,
  Min,
  IsIn,
} from 'class-validator';

export class CreateSuggestionDto {
  @ApiProperty({ description: 'Type of suggested edit', enum: ['insert', 'delete', 'replace'] })
  @IsString()
  @IsIn(['insert', 'delete', 'replace'])
  type!: 'insert' | 'delete' | 'replace';

  @ApiPropertyOptional({ description: 'Original text to be replaced or deleted' })
  @IsString()
  @IsOptional()
  originalText?: string;

  @ApiPropertyOptional({ description: 'Suggested text to be inserted or substituted' })
  @IsString()
  @IsOptional()
  suggestedText?: string;

  @ApiProperty({ description: 'Starting line number (1-based)', example: 12 })
  @IsInt()
  @Min(1)
  fromLine!: number;

  @ApiPropertyOptional({ description: 'Starting column (1-based)', default: 1 })
  @IsInt()
  @Min(1)
  @IsOptional()
  fromColumn?: number;

  @ApiProperty({ description: 'Ending line number (1-based)', example: 12 })
  @IsInt()
  @Min(1)
  toLine!: number;

  @ApiPropertyOptional({ description: 'Ending column (1-based)', default: 1 })
  @IsInt()
  @Min(1)
  @IsOptional()
  toColumn?: number;

  @ApiPropertyOptional({ description: 'Reason or explanation for this suggestion' })
  @IsString()
  @IsOptional()
  description?: string;
}

export class ResolveSuggestionDto {
  @ApiProperty({ description: 'Action to perform on the suggestion', enum: ['accept', 'reject'] })
  @IsString()
  @IsIn(['accept', 'reject'])
  action!: 'accept' | 'reject';
}
