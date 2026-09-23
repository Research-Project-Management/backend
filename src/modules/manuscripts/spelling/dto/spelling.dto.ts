/**
 * spelling/dto/spelling.dto.ts
 * Data Transfer Objects for Spelling & Custom Dictionary operations.
 */

import { IsNotEmpty, IsNumber, IsOptional, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CheckSpellingDto {
  @ApiPropertyOptional({ description: 'Raw LaTeX text content to check' })
  @IsString()
  @IsOptional()
  text?: string;

  @ApiPropertyOptional({ description: 'Document ID in docstore to fetch content from' })
  @IsString()
  @IsOptional()
  docId?: string;

  @ApiPropertyOptional({ description: 'Language code (en-US, en-GB, vi-VN, etc.)', default: 'en-US' })
  @IsString()
  @IsOptional()
  language?: string;
}

export class LearnWordDto {
  @ApiProperty({ description: 'Word to add to dictionary' })
  @IsString()
  @IsNotEmpty({ message: 'word is required' })
  word!: string;
}

export class SuggestionQueryDto {
  @ApiProperty({ description: 'Word to get suggestions for' })
  @IsString()
  @IsNotEmpty({ message: 'word is required' })
  word!: string;

  @ApiPropertyOptional({ description: 'Language code (en-US, vi-VN)', default: 'en-US' })
  @IsString()
  @IsOptional()
  language?: string;

  @ApiPropertyOptional({ description: 'Maximum suggestions to return', default: 5 })
  @IsNumber()
  @IsOptional()
  maxSuggestions?: number;
}

export class MisspelledWordDto {
  @ApiProperty()
  word!: string;

  @ApiProperty()
  line!: number;

  @ApiProperty()
  col!: number;

  @ApiProperty()
  length!: number;

  @ApiProperty({ type: [String] })
  suggestions!: string[];
}

export class SpellingReportDto {
  @ApiProperty()
  language!: string;

  @ApiProperty()
  totalWordsChecked!: number;

  @ApiProperty()
  misspelledCount!: number;

  @ApiProperty({ type: [MisspelledWordDto] })
  errors!: MisspelledWordDto[];
}

export class CustomDictionaryResponseDto {
  @ApiProperty()
  scope!: string;

  @ApiProperty({ type: [String] })
  words!: string[];

  @ApiProperty()
  count!: number;
}
