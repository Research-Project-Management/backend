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

  @IsString()
  @IsOptional()
  workspaceId?: string;
}

import { PartialType } from '@nestjs/swagger';

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
