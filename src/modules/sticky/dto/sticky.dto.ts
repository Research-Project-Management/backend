import {
  IsArray,
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';
import { ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { ALLOWED_STICKY_COLORS } from '../utils/sticky.utils';

export class CreateStickyDto {
  @ApiPropertyOptional({ description: 'Optional sticky title' })
  @IsString()
  @IsOptional()
  title?: string;

  @ApiPropertyOptional({ description: 'HTML or text content of sticky' })
  @IsString()
  @IsOptional()
  content?: string;

  @ApiPropertyOptional({
    description: 'Design system sticky color token',
    enum: ALLOWED_STICKY_COLORS,
    default: 'yellow-1',
  })
  @IsString()
  @IsOptional()
  @IsIn(ALLOWED_STICKY_COLORS, {
    message: `Color must be one of: ${ALLOWED_STICKY_COLORS.join(', ')}`,
  })
  color?: string;

  @ApiPropertyOptional({ description: 'Board coordinate position' })
  @IsObject()
  @IsOptional()
  position?: { x: number; y: number };

  @ApiPropertyOptional({ description: 'Associated project ID' })
  @IsUUID('4')
  @IsOptional()
  projectId?: string;

  @ApiPropertyOptional({
    description: 'Scope of sticky note',
    enum: ['personal', 'project'],
  })
  @IsString()
  @IsOptional()
  @IsIn(['personal', 'project'])
  scope?: 'personal' | 'project';
}

export class UpdateStickyDto extends PartialType(CreateStickyDto) {
  @IsUUID('4')
  @IsOptional()
  id?: string;

  @IsString()
  @IsOptional()
  createdAt?: string;

  @IsString()
  @IsOptional()
  updatedAt?: string;
}

export class ReorderStickiesDto {
  @IsArray()
  @IsNotEmpty({ message: 'Sticky IDs are required' })
  stickyIds!: string[];
}

export class GetStickiesQueryDto {
  @ApiPropertyOptional({
    description: 'Optional project ID to filter stickies',
  })
  @IsUUID('4')
  @IsOptional()
  projectId?: string;

  @ApiPropertyOptional({
    description: 'Optional search keyword for title and content',
  })
  @IsString()
  @IsOptional()
  search?: string;
}
