import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsEnum,
  IsNumber,
  IsBoolean,
  IsArray,
  ValidateNested,
  MaxLength,
  IsUUID,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
export class CreateProjectStateDto {
  @ApiProperty({
    description: 'Name of the project state',
    example: 'Field Trip & Sampling',
    maxLength: 100,
  })
  @IsString()
  @IsNotEmpty({ message: 'State name cannot be empty' })
  @MaxLength(100, { message: 'State name must not exceed 100 characters' })
  name!: string;

  @ApiPropertyOptional({
    description: 'Description or guidelines for this project state',
    example: 'Field specimen collection and on-site testing phase.',
  })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({
    description: 'Badge hex or CSS color',
    example: '#0284c7',
    default: '#0284c7',
  })
  @IsString()
  @IsOptional()
  color?: string;

  @ApiPropertyOptional({
    description: 'Order sequence for drag and drop reordering',
    example: 3,
    default: 0,
  })
  @IsNumber()
  @IsOptional()
  sequence?: number;

  @ApiPropertyOptional({
    description:
      'Whether this state is the initial default state for newly created projects',
    default: false,
  })
  @IsBoolean()
  @IsOptional()
  isDefault?: boolean;
}

export class UpdateProjectStateItemDto {
  @ApiPropertyOptional({
    description: 'Updated state name',
    example: 'Field Survey & Sampling',
    maxLength: 100,
  })
  @IsString()
  @IsOptional()
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({
    description: 'Updated description',
  })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({
    description: 'Updated color code',
    example: '#8b5cf6',
  })
  @IsString()
  @IsOptional()
  color?: string;

  @ApiPropertyOptional({
    description: 'Updated sequence position',
  })
  @IsNumber()
  @IsOptional()
  sequence?: number;

  @ApiPropertyOptional({
    description: 'Set as default starting state',
  })
  @IsBoolean()
  @IsOptional()
  isDefault?: boolean;
}

export class TransitionProjectStateDto {
  @ApiPropertyOptional({
    description:
      'Target State UUID to transition project to, or null to unassign',
    example: '01957c91-2345-7890-abcd-ef0123456789',
    nullable: true,
  })
  @IsUUID('all', { message: 'State ID must be a valid UUID' })
  @IsOptional()
  stateId?: string | null;
}

export class ReorderProjectStateItemDto {
  @ApiProperty({
    description: 'State UUID',
    example: '01957c91-2345-7890-abcd-ef0123456789',
  })
  @IsUUID('all', { message: 'State ID must be a valid UUID' })
  id!: string;

  @ApiProperty({
    description: 'New sequence order position after drag & drop',
    example: 2,
  })
  @IsNumber()
  sequence!: number;
}

export class ReorderProjectStatesDto {
  @ApiProperty({
    description: 'List of state IDs with their new sequence positions',
    type: [ReorderProjectStateItemDto],
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReorderProjectStateItemDto)
  states!: ReorderProjectStateItemDto[];
}

export class DeleteProjectStateDto {
  @ApiPropertyOptional({
    description:
      'Fallback state ID to migrate the project to if it is currently at the state being deleted',
    example: '01957c91-2345-7890-abcd-ef0123456789',
  })
  @IsUUID('all', { message: 'Fallback state ID must be a valid UUID' })
  @IsOptional()
  fallbackStateId?: string;
}
