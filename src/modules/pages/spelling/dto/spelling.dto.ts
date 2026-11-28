/**
 * spelling/dto/spelling.dto.ts
 * HTTP DTOs & validation guardrails for Spelling Check and Project Dictionary.
 */

import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CheckSpellingDto {
  @ApiProperty({
    description: 'Unique words extracted from LaTeX prose by the editor',
    type: [String],
  })
  @IsArray()
  @ArrayMaxSize(5000)
  @IsString({ each: true })
  @MaxLength(128, { each: true })
  words!: string[];

  @ApiPropertyOptional({
    description:
      'BCP-47 language tag (en-US, en-GB, vi-VN, fr-FR, de-DE, es-ES) or "off" to disable',
    default: 'en-US',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().replace(/_/g, '-') : value,
  )
  @IsString()
  @MaxLength(16)
  @IsOptional()
  language?: string;
}

export class LearnWordDto {
  @ApiProperty({ description: 'Word to add to the project dictionary' })
  @IsString()
  @MaxLength(128)
  @IsNotEmpty({ message: 'word is required' })
  word!: string;
}

export class MisspelledWordDto {
  @ApiProperty()
  word!: string;

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
  @ApiProperty({ type: [String] })
  words!: string[];

  @ApiProperty()
  count!: number;
}
