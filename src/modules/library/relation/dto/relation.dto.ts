import { IsString, IsNotEmpty, IsOptional, IsIn } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { RelationType } from '../types/relation.types';

export class LinkPaperDto {
  @ApiProperty({
    description: 'Target paper ID to establish relationship with',
    example: 'target-paper-uuid',
  })
  @IsString()
  @IsNotEmpty()
  targetPaperId!: string;

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
    description: 'Optional note describing why these papers are related',
  })
  @IsString()
  @IsOptional()
  note?: string;
}
