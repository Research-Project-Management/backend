import {
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { ALLOWED_STICKY_COLORS } from '../utils/sticky.utils';

export class PositionDto {
  @ApiProperty({ description: 'X coordinate on the board', example: 100 })
  @IsNumber()
  x!: number;

  @ApiProperty({ description: 'Y coordinate on the board', example: 200 })
  @IsNumber()
  y!: number;
}

export class CreateStickyDto {
  @ApiPropertyOptional({
    description: 'Optional client-generated UUID v7',
    format: 'uuid',
    example: '01920b92-7f12-7890-a123-456789abcdef',
  })
  @IsUUID('7', { message: 'ID must be a valid UUID v7' })
  @IsOptional()
  id?: string;

  @ApiPropertyOptional({
    description: 'Optional sticky title',
    example: 'Research Hypothesis',
  })
  @IsString()
  @IsOptional()
  title?: string;

  @ApiPropertyOptional({
    description: 'HTML or text content of sticky',
    example: '<p>Initial ideas and findings</p>',
  })
  @IsString()
  @IsOptional()
  content?: string;

  @ApiPropertyOptional({
    description: 'Design system sticky color token',
    enum: ALLOWED_STICKY_COLORS,
    default: 'yellow-1',
    example: 'yellow-1',
  })
  @IsString()
  @IsOptional()
  @IsIn(ALLOWED_STICKY_COLORS, {
    message: `Color must be one of: ${ALLOWED_STICKY_COLORS.join(', ')}`,
  })
  color?: string;

  @ApiPropertyOptional({
    description: 'Board coordinate position',
    type: () => PositionDto,
    example: { x: 100, y: 200 },
  })
  @ValidateNested()
  @Type(() => PositionDto)
  @IsOptional()
  position?: PositionDto;
}

export class UpdateStickyDto extends PartialType(CreateStickyDto) {
  @ApiPropertyOptional({
    description: 'Creation timestamp string (ignored during update)',
  })
  @IsString()
  @IsOptional()
  createdAt?: string;

  @ApiPropertyOptional({
    description: 'Update timestamp string (ignored during update)',
  })
  @IsString()
  @IsOptional()
  updatedAt?: string;
}

export class ReorderStickiesDto {
  @ApiProperty({
    description: 'Ordered list of sticky UUID v7s',
    type: [String],
    example: [
      '01920b92-7f12-7890-a123-456789abcdef',
      '01920b92-8012-7890-a123-456789abcdef',
    ],
  })
  @IsArray()
  @ArrayNotEmpty({ message: 'Sticky IDs array must not be empty' })
  @IsUUID('7', {
    each: true,
    message: 'Each sticky ID must be a valid UUID v7',
  })
  stickyIds!: string[];
}

export class GetStickiesQueryDto {
  @ApiPropertyOptional({
    description: 'Optional search keyword for title and content',
    example: 'research',
  })
  @IsString()
  @IsOptional()
  search?: string;
}

// ─── Response DTOs for OpenAPI / Swagger ──────────────────────────────────────

export class StickyResponseDto {
  @ApiProperty({
    description: 'Unique identifier (UUID v7)',
    format: 'uuid',
    example: '01920b92-7f12-7890-a123-456789abcdef',
  })
  id!: string;

  @ApiProperty({
    description: 'Sticky title',
    example: 'Research Hypothesis',
  })
  title!: string;

  @ApiProperty({
    description: 'Sanitized HTML content',
    example: '<p>Initial ideas and findings</p>',
  })
  content!: string;

  @ApiProperty({
    description: 'Color token',
    enum: ALLOWED_STICKY_COLORS,
    example: 'yellow-1',
  })
  color!: string;

  @ApiProperty({
    description: 'Sort order index within user board',
    example: 0,
  })
  order!: number;

  @ApiProperty({
    description: 'Coordinate position on canvas',
    type: () => PositionDto,
    example: { x: 100, y: 200 },
  })
  position!: PositionDto;

  @ApiProperty({
    description: 'Owner user UUID',
    format: 'uuid',
    example: '11111111-1111-1111-1111-111111111111',
  })
  userId!: string;

  @ApiProperty({
    description: 'Creation timestamp',
    example: '2026-09-20T05:00:00.000Z',
  })
  createdAt!: Date | string;

  @ApiProperty({
    description: 'Last update timestamp',
    example: '2026-09-20T05:10:00.000Z',
  })
  updatedAt!: Date | string;
}

export class StickyListResponseDto {
  @ApiProperty({
    description: 'List of personal sticky notes',
    type: [StickyResponseDto],
  })
  stickies!: StickyResponseDto[];
}

export class SingleStickyResponseDto {
  @ApiProperty({
    description: 'The sticky note object',
    type: StickyResponseDto,
  })
  sticky!: StickyResponseDto;
}

export class DeleteStickyResponseDto {
  @ApiProperty({
    description: 'Deletion status flag',
    example: true,
  })
  success!: boolean;

  @ApiProperty({
    description: 'Human-readable message',
    example: 'Sticky deleted successfully',
  })
  message!: string;
}

export class ReorderStickiesResponseDto {
  @ApiProperty({
    description: 'Operation status flag',
    example: true,
  })
  success!: boolean;

  @ApiProperty({
    description: 'Number of reordered stickies',
    example: 3,
  })
  count!: number;

  @ApiPropertyOptional({
    description: 'Reordered stickies',
    type: [StickyResponseDto],
  })
  stickies?: StickyResponseDto[];
}
