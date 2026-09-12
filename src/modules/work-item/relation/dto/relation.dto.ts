import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, IsIn } from 'class-validator';

export const VALID_RELATION_TYPES = [
  'blocks',
  'blocked_by',
  'relates_to',
  'duplicate_of',
] as const;

export class AddRelationDto {
  @ApiProperty({
    description: 'Target task ID or identifier to link with',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @IsString()
  @IsNotEmpty()
  targetTaskId!: string;

  @ApiProperty({
    description: 'Relation type',
    enum: VALID_RELATION_TYPES,
    example: 'blocks',
  })
  @IsString()
  @IsNotEmpty()
  @IsIn(VALID_RELATION_TYPES)
  type!: 'blocks' | 'blocked_by' | 'relates_to' | 'duplicate_of';
}

export class RelationResponseDto {
  @ApiProperty({ example: 'Relation added successfully' })
  message!: string;
}
