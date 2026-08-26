import {
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
} from 'class-validator';
import { PageStatus, Prisma } from '@prisma/client';

export class CreatePageDto {
  @IsString()
  @IsNotEmpty({ message: 'Page title is required' })
  title!: string;

  @IsString()
  @IsOptional()
  slug?: string;

  @IsString()
  @IsOptional()
  icon?: string;

  @IsString()
  @IsOptional()
  coverImage?: string;

  @IsNumber()
  @IsOptional()
  rank?: number;

  @IsBoolean()
  @IsOptional()
  isLocked?: boolean;

  @IsBoolean()
  @IsOptional()
  isPublished?: boolean;

  @IsOptional()
  content?: Prisma.InputJsonValue;

  @IsEnum(PageStatus)
  @IsOptional()
  status?: PageStatus;

  @IsString()
  @IsOptional()
  workspaceId?: string;

  @IsString()
  @IsOptional()
  projectId?: string;

  @IsString()
  @IsOptional()
  parentPage?: string;

  @IsString()
  @IsOptional()
  parentPageId?: string;
}

export class UpdatePageDto {
  @IsString()
  @IsOptional()
  title?: string;

  @IsString()
  @IsOptional()
  slug?: string;

  @IsString()
  @IsOptional()
  icon?: string;

  @IsString()
  @IsOptional()
  coverImage?: string;

  @IsNumber()
  @IsOptional()
  rank?: number;

  @IsBoolean()
  @IsOptional()
  isLocked?: boolean;

  @IsBoolean()
  @IsOptional()
  isPublished?: boolean;

  @IsOptional()
  content?: Prisma.InputJsonValue;

  @IsEnum(PageStatus)
  @IsOptional()
  status?: PageStatus;

  @IsString()
  @IsOptional()
  parentPage?: string;

  @IsString()
  @IsOptional()
  parentPageId?: string;

  @IsString()
  @IsOptional()
  mainFileId?: string;

  @IsString()
  @IsOptional()
  pdfThumbnail?: string;
}

export class SetMainFileDto {
  @IsString()
  @IsNotEmpty({ message: 'Main file ID is required' })
  mainFileId!: string;
}

export class UpdateThumbnailDto {
  @IsString()
  @IsNotEmpty({ message: 'Thumbnail data is required' })
  pdfThumbnail!: string;
}
