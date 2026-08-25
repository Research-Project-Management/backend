import { IsString, IsNotEmpty, IsOptional, IsIn } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { RelationType } from '../types/knowledge.types';

export class LinkKnowledgeItemDto {
  @ApiPropertyOptional({
    description: 'Target item ID to establish relationship with',
    example: 'target-item-uuid',
  })
  @IsString()
  @IsOptional()
  targetItemId?: string;

  @ApiPropertyOptional({
    description: 'Legacy alias for targetItemId',
    example: 'target-item-uuid',
  })
  @IsString()
  @IsOptional()
  targetPaperId?: string;

  @ApiPropertyOptional({
    description: 'Semantic relationship type',
    enum: ['related', 'extends', 'rebuts', 'uses_dataset', 'survey_of'],
    default: 'related',
  })
  @IsString()
  @IsOptional()
  @IsIn(['related', 'extends', 'rebuts', 'uses_dataset', 'survey_of'])
  relationType?: RelationType;

  @ApiPropertyOptional({
    description: 'Optional note describing why these items are related',
  })
  @IsString()
  @IsOptional()
  note?: string;
}

// Alias for backward compatibility
export const LinkPaperDto = LinkKnowledgeItemDto;
export type LinkPaperDto = LinkKnowledgeItemDto;
