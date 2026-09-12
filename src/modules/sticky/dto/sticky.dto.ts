import {
  IsArray,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
} from 'class-validator';
import { PartialType } from '@nestjs/swagger';

export class CreateStickyDto {
  @IsString()
  @IsOptional()
  title?: string;

  @IsString()
  @IsNotEmpty({ message: 'Sticky content is required' })
  content!: string;

  @IsString()
  @IsOptional()
  color?: string;

  @IsObject()
  @IsOptional()
  position?: { x: number; y: number };

  @IsString()
  @IsOptional()
  projectId?: string;

  @IsString()
  @IsOptional()
  scope?: 'personal' | 'project';
}

export class UpdateStickyDto extends PartialType(CreateStickyDto) {
  @IsString()
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
