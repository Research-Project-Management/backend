import { IsString, IsOptional, IsNotEmpty, IsArray } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateNoteDto {
  @ApiPropertyOptional({ description: 'Target item ID for child note' })
  @IsString()
  @IsOptional()
  itemId?: string;

  @ApiProperty({ description: 'Note title' })
  @IsString()
  @IsNotEmpty()
  title!: string;

  @ApiProperty({ description: 'Markdown or HTML note content' })
  @IsString()
  @IsNotEmpty()
  content!: string;

  @ApiPropertyOptional({ description: 'Tags array', type: [String] })
  @IsArray()
  @IsOptional()
  tags?: string[];
}

export class UpdateNoteDto {
  @ApiPropertyOptional({ description: 'Updated note title' })
  @IsString()
  @IsOptional()
  title?: string;

  @ApiPropertyOptional({ description: 'Updated note content' })
  @IsString()
  @IsOptional()
  content?: string;

  @ApiPropertyOptional({ description: 'Updated tags', type: [String] })
  @IsArray()
  @IsOptional()
  tags?: string[];
}
