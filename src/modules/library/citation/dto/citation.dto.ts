import { IsString, IsOptional, IsArray, IsNotEmpty } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ExportBibtexDto {
  @ApiPropertyOptional({ description: 'Collection ID filter' })
  @IsString()
  @IsOptional()
  collectionId?: string;
}

export class ImportBibtexDto {
  @ApiProperty({ description: 'Raw BibTeX text string to import' })
  @IsString()
  @IsNotEmpty()
  bibtex!: string;

  @ApiPropertyOptional({ description: 'Target Collection ID' })
  @IsString()
  @IsOptional()
  collectionId?: string;
}

export class FormatCitationQueryDto {
  @ApiPropertyOptional({
    description:
      'Citation style (apa, ieee, nature, harvard, chicago, mla, vancouver)',
    example: 'apa',
    default: 'apa',
  })
  @IsString()
  @IsOptional()
  style?: string;
}

export class FormatBatchCitationDto {
  @ApiPropertyOptional({
    description: 'Array of item IDs to format',
    type: [String],
    example: ['item-id-1', 'item-id-2'],
  })
  @IsArray()
  @IsOptional()
  itemIds?: string[];

  @ApiPropertyOptional({
    description: 'Legacy alias for itemIds',
    type: [String],
  })
  @IsArray()
  @IsOptional()
  paperIds?: string[];

  @ApiPropertyOptional({
    description:
      'Citation style (apa, ieee, nature, harvard, chicago, mla, vancouver)',
    example: 'apa',
    default: 'apa',
  })
  @IsString()
  @IsOptional()
  style?: string;
}
