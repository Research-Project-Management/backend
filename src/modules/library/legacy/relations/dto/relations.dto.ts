import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsIn,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { RelationType } from '../types/relations.types';

export class LinkRelatedItemDto {
  @ApiPropertyOptional({
    description: 'Target item ID to establish relationship with',
    example: 'target-item-uuid',
  })
  @IsString()
  @IsOptional()
  targetItemId?: string;

  @ApiPropertyOptional({
    description: 'Semantic relationship type',
    enum: [
      'related',
      'extends',
      'rebuts',
      'uses_dataset',
      'survey_of',
      'cites',
      'cited_by',
      'replicates',
      'is_preprint_of',
      'is_published_version_of',
      'is_translation_of',
      'supplements',
    ],
    default: 'related',
  })
  @IsString()
  @IsOptional()
  relationType?: RelationType;

  @ApiPropertyOptional({
    description: 'Optional note describing why these items are related',
  })
  @IsString()
  @IsOptional()
  @MaxLength(500)
  note?: string;
}

export class LinkRelationItemDto {
  @ApiProperty({ description: 'Target item/paper ID to link to' })
  @IsString()
  @IsNotEmpty()
  targetItemId!: string;

  @ApiPropertyOptional({
    description: 'Semantic relation type',
    default: 'cites',
  })
  @IsString()
  @IsOptional()
  relationType?: string = 'cites';

  @ApiPropertyOptional({ description: 'Optional context or rationale note' })
  @IsString()
  @IsOptional()
  @MaxLength(500)
  description?: string;
}
