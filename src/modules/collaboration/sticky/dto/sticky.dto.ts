import {
  IsArray,
  IsEnum,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
} from 'class-validator';
import { StickyScope } from '@prisma/client';

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

  @IsEnum(StickyScope)
  @IsOptional()
  scope?: StickyScope;

  @IsObject()
  @IsOptional()
  position?: { x: number; y: number };

  @IsString()
  @IsOptional()
  projectId?: string;
}

export class UpdateStickyDto {
  @IsString()
  @IsOptional()
  title?: string;

  @IsString()
  @IsOptional()
  content?: string;

  @IsString()
  @IsOptional()
  color?: string;

  @IsEnum(StickyScope)
  @IsOptional()
  scope?: StickyScope;

  @IsObject()
  @IsOptional()
  position?: { x: number; y: number };

  @IsString()
  @IsOptional()
  projectId?: string;
}

export class ReorderStickiesDto {
  @IsArray()
  @IsNotEmpty({ message: 'Sticky IDs are required' })
  stickyIds!: string[];
}
