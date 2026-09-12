import {
  IsArray,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { StateGroup } from '../types/state.types';

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
