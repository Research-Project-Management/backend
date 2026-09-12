import {
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { StateGroup, STATE_GROUPS } from '../types/state.types';

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
