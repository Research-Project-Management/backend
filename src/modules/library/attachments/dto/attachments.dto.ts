import {
  IsString,
  IsInt,
  IsOptional,
  IsNotEmpty,
  IsIn,
  IsObject,
  IsUrl,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AnnotationType, RectBounds } from '../annotations/annotations.types';

export class CreateAnnotationDto {
  @ApiProperty({
    description: 'Type of annotation (highlight, underline, note, box)',
    enum: ['highlight', 'underline', 'note', 'box'],
    example: 'highlight',
  })
  @IsString()
  @IsIn(['highlight', 'underline', 'note', 'box'])
  type!: AnnotationType;

  @ApiProperty({ description: '1-based PDF page number', example: 1 })
  @IsInt()
  pageNumber!: number;

  @ApiProperty({ description: 'Hex color code', example: '#FFEB3B' })
  @IsString()
  @IsNotEmpty()
  color!: string;

  @ApiPropertyOptional({ description: 'Quoted text from PDF' })
  @IsString()
  @IsOptional()
  quote?: string;

  @ApiPropertyOptional({ description: 'User personal comment on highlight' })
  @IsString()
  @IsOptional()
  comment?: string;

  @ApiPropertyOptional({ description: 'Bounding rectangle on PDF page' })
  @IsObject()
  @IsOptional()
  rect?: RectBounds;

  @ApiPropertyOptional({
    description: 'Attachment ID if bound to specific PDF',
  })
  @IsString()
  @IsOptional()
  attachmentId?: string;
}

export class UpdateAnnotationDto {
  @ApiPropertyOptional({ description: 'Updated comment' })
  @IsString()
  @IsOptional()
  comment?: string;

  @ApiPropertyOptional({ description: 'Updated hex color' })
  @IsString()
  @IsOptional()
  color?: string;
}

export class ExtractPdfMetadataDto {
  @ApiProperty({ description: 'PDF file URL to extract metadata from' })
  @IsString()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @IsNotEmpty()
  fileUrl!: string;
}
