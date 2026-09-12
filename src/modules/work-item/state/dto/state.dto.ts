import {
  IsArray,
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
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

export class UpdateStateDto {
  @ApiPropertyOptional({
    description: 'Updated display name of the state',
    example: 'Peer Review',
  })
  @IsString()
  @IsOptional()
  name?: string;

  @ApiPropertyOptional({
    description: 'Backwards-compatibility alias for name',
    example: 'Peer Review',
  })
  @IsString()
  @IsOptional()
  title?: string;

  @ApiPropertyOptional({
    description: 'Updated state group category',
    enum: STATE_GROUPS,
    example: 'started',
  })
  @IsIn(STATE_GROUPS, {
    message: `group must be one of: ${STATE_GROUPS.join(', ')}`,
  })
  @IsOptional()
  group?: StateGroup;

  @ApiPropertyOptional({
    description: 'Updated hex color for state indicator',
    example: '#A855F7',
  })
  @IsString()
  @IsOptional()
  @Matches(/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/, {
    message: 'color must be a valid hex color code (e.g. #6366F1)',
  })
  color?: string;

  @ApiPropertyOptional({
    description: 'Backwards-compatibility alias for color',
    example: '#A855F7',
  })
  @IsString()
  @IsOptional()
  accentColor?: string;

  @ApiPropertyOptional({
    description: 'Updated description of the state purposes',
    example: 'Waiting for security approval',
  })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({
    description: 'Updated sequence order index',
    example: 3200,
  })
  @IsNumber()
  @IsOptional()
  sequence?: number;

  @ApiPropertyOptional({
    description: 'Designate this state as the project default state',
  })
  @IsBoolean()
  @IsOptional()
  isDefault?: boolean;
}

export class StateOrderItemDto {
  @ApiProperty({ description: 'State ID', example: 'todo' })
  @IsString()
  @IsNotEmpty()
  id!: string;

  @ApiPropertyOptional({
    description: 'New sequence order index',
    example: 1500,
  })
  @IsNumber()
  @IsOptional()
  sequence?: number;

  @ApiPropertyOptional({
    description: 'Optional group to move state into',
    example: 'started',
  })
  @IsString()
  @IsOptional()
  group?: StateGroup;

  @ApiPropertyOptional({ description: 'Backwards-compatibility title' })
  @IsString()
  @IsOptional()
  title?: string;

  @ApiPropertyOptional({ description: 'Backwards-compatibility accentColor' })
  @IsString()
  @IsOptional()
  accentColor?: string;
}

export class ReorderStatesDto {
  @ApiPropertyOptional({
    description: 'Ordered list of states with sequences',
    type: [StateOrderItemDto],
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => StateOrderItemDto)
  @IsOptional()
  states?: StateOrderItemDto[];

  @ApiPropertyOptional({
    description: 'Backwards-compatibility alias for states',
    type: [StateOrderItemDto],
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => StateOrderItemDto)
  @IsOptional()
  columns?: StateOrderItemDto[];
}
