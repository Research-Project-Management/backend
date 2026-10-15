import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, IsIn } from 'class-validator';
import { RelationType } from '@/modules/work-item/relation/types/relation.types';

export const VALID_RELATION_TYPES = [
  'blocks',
  'blocked_by',
  'relates_to',
  'duplicate_of',
  'duplicated_by',
  'starts_before',
  'starts_after',
  'finishes_before',
  'finishes_after',
  'start_to_finish',
  'finish_to_start',
  'start_to_start',
  'finish_to_finish',
  'FINISH_TO_START',
  'START_TO_START',
  'FINISH_TO_FINISH',
  'START_TO_FINISH',
  'implements',
] as const;

export class AddRelationDto {
  @ApiProperty({
    description: 'Target WorkItem ID or identifier to link with',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @IsString()
  @IsNotEmpty()
  targetWorkItemId!: string;

  @ApiProperty({
    description: 'Relation type',
    enum: VALID_RELATION_TYPES,
    example: 'blocks',
  })
  @IsString()
  @IsNotEmpty()
  @IsIn(VALID_RELATION_TYPES)
  type!: RelationType;
}

export class RelationResponseDto {
  @ApiProperty({ example: 'Relation added successfully' })
  message!: string;
}
