import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { StateGroup, STATE_GROUPS } from '../types/state.types';

export class CreateStateDto {
  @ApiProperty({
    description: 'Display name of the state',
    example: 'In Review',
  })
  @IsString()
  @IsNotEmpty({ message: 'State name is required' })
  name!: string;

  @ApiPropertyOptional({
    description: 'Backwards-compatibility alias for name',
    example: 'In Review',
  })
  @IsString()
  @IsOptional()
  title?: string;

  @ApiProperty({
    description: 'State group category (lifecycle stage)',
    enum: STATE_GROUPS,
    example: 'started',
  })
  @IsIn(STATE_GROUPS, {
    message: `group must be one of: ${STATE_GROUPS.join(', ')}`,
  })
  group!: StateGroup;

  @ApiPropertyOptional({
    description: 'Hex color for the state badge and Kanban column indicator',
    example: '#8B5CF6',
    default: '#6366F1',
  })
  @IsString()
  @IsOptional()
  @Matches(/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/, {
    message: 'color must be a valid hex color code (e.g. #6366F1)',
  })
  color?: string;

  @ApiPropertyOptional({
    description: 'Backwards-compatibility alias for color',
    example: '#8B5CF6',
  })
  @IsString()
  @IsOptional()
  accentColor?: string;

  @ApiPropertyOptional({
    description: 'Detailed description of the state purposes and exit criteria',
    example: 'Code review completed by at least 2 peers',
  })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({
    description: 'Explicit sequence order index',
    example: 3500,
  })
  @IsNumber()
  @IsOptional()
  sequence?: number;

  @ApiPropertyOptional({
    description:
      'Whether this state should be the default state for newly created work items',
    default: false,
  })
  @IsBoolean()
  @IsOptional()
  isDefault?: boolean;

  @ApiPropertyOptional({
    description: 'Optional custom unique identifier/slug for the state',
    example: 'in-review',
  })
  @IsString()
  @IsOptional()
  id?: string;
}
