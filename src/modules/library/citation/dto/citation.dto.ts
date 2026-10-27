import {
  IsNotEmpty,
  IsOptional,
  IsString,
  IsNumber,
  IsArray,
  IsObject,
  ArrayMaxSize,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  CitationItemInput,
  CitationStyleId,
} from '@/modules/library/citation/types/citation.types';

export class FormatCitationDto {
  @ApiProperty({ description: 'Item metadata to format citation from' })
  @IsNotEmpty()
  @IsObject()
  item!: CitationItemInput;

  @ApiPropertyOptional({
    description: 'Citation style ID (e.g. apa, ieee, nature, harvard)',
    example: 'apa-7th',
  })
  @IsOptional()
  @IsString()
  styleId?: CitationStyleId;

  @ApiPropertyOptional({ description: 'Citation position index', example: 1 })
  @IsOptional()
  @IsNumber()
  index?: number;
}

export class FormatBatchCitationDto {
  @ApiProperty({ description: 'Array of item metadata' })
  @IsArray()
  @IsNotEmpty()
  @ArrayMaxSize(500)
  items!: CitationItemInput[];

  @ApiPropertyOptional({
    description: 'Citation style ID',
    example: 'apa-7th',
  })
  @IsOptional()
  @IsString()
  styleId?: CitationStyleId;
}
