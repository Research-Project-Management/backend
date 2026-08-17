import {
  IsArray,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
} from 'class-validator';
import { AttachmentType } from '@prisma/client';

export class IngestPaperDto {
  @IsString()
  @IsOptional()
  source?: 'upload' | 'storage' | 'identifier';

  @IsString()
  @IsOptional()
  fileId?: string;

  @IsString()
  @IsOptional()
  collectionId?: string;

  @IsString()
  @IsOptional()
  title?: string;

  @IsString()
  @IsOptional()
  filename?: string;

  @IsString()
  @IsOptional()
  fileUrl?: string;

  @IsNumber()
  @IsOptional()
  size?: number;

  @IsString()
  @IsOptional()
  mimeType?: string;

  @IsArray()
  @IsOptional()
  authors?: string[];

  @IsNumber()
  @IsOptional()
  year?: number;

  @IsString()
  @IsOptional()
  doi?: string;

  @IsString()
  @IsOptional()
  citationKey?: string;
}

export class UploadPaperDto {
  @IsString()
  @IsNotEmpty({ message: 'Title is required' })
  title!: string;

  @IsString()
  @IsNotEmpty({ message: 'Filename is required' })
  filename!: string;

  @IsString()
  @IsNotEmpty({ message: 'File URL is required' })
  fileUrl!: string;

  @IsString()
  @IsOptional()
  collectionId?: string;

  @IsString()
  @IsOptional()
  fileId?: string;

  @IsNumber()
  @IsOptional()
  size?: number;

  @IsString()
  @IsOptional()
  mimeType?: string;

  @IsArray()
  @IsOptional()
  authors?: string[];

  @IsNumber()
  @IsOptional()
  year?: number;

  @IsString()
  @IsOptional()
  doi?: string;

  @IsString()
  @IsOptional()
  abstract?: string;

  @IsString()
  @IsOptional()
  journal?: string;

  @IsString()
  @IsOptional()
  publisher?: string;

  @IsArray()
  @IsOptional()
  keywords?: string[];

  @IsString()
  @IsOptional()
  volume?: string;

  @IsString()
  @IsOptional()
  issue?: string;

  @IsString()
  @IsOptional()
  pages?: string;

  @IsString()
  @IsOptional()
  issn?: string;

  @IsString()
  @IsOptional()
  isbn?: string;

  @IsString()
  @IsOptional()
  url?: string;

  @IsString()
  @IsOptional()
  type?: string;

  @IsString()
  @IsOptional()
  language?: string;

  @IsString()
  @IsOptional()
  journalAbbr?: string;

  @IsString()
  @IsOptional()
  shortTitle?: string;

  @IsString()
  @IsOptional()
  rights?: string;

  @IsString()
  @IsOptional()
  citationKey?: string;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  notes?: string[];
}

export class AddAttachmentDto {
  @IsString()
  @IsNotEmpty({ message: 'Filename is required' })
  filename!: string;

  @IsString()
  @IsNotEmpty({ message: 'Attachment URL is required' })
  url!: string;

  @IsString()
  @IsOptional()
  fileId?: string;

  @IsNumber()
  @IsOptional()
  size?: number;

  @IsString()
  @IsOptional()
  mimeType?: string;

  @IsEnum(AttachmentType)
  @IsOptional()
  attachmentType?: AttachmentType;
}

export class ImportStoragePaperDto {
  @IsString()
  @IsNotEmpty({ message: 'File ID is required' })
  fileId!: string;

  @IsString()
  @IsOptional()
  collectionId?: string;

  @IsString()
  @IsOptional()
  title?: string;

  @IsArray()
  @IsOptional()
  authors?: string[];

  @IsString()
  @IsOptional()
  doi?: string;

  @IsString()
  @IsOptional()
  citationKey?: string;
}

export class UpdatePaperDto {
  @IsString()
  @IsOptional()
  title?: string;

  @IsArray()
  @IsOptional()
  authors?: string[];

  @IsNumber()
  @IsOptional()
  year?: number;

  @IsString()
  @IsOptional()
  doi?: string;

  @IsString()
  @IsOptional()
  abstract?: string;

  @IsArray()
  @IsOptional()
  keywords?: string[];

  @IsString()
  @IsOptional()
  itemType?: string;

  @IsArray()
  @IsOptional()
  editors?: string[];

  @IsString()
  @IsOptional()
  journal?: string;

  @IsString()
  @IsOptional()
  publicationTitle?: string;

  @IsString()
  @IsOptional()
  publicationDate?: string;

  @IsString()
  @IsOptional()
  publisher?: string;

  @IsString()
  @IsOptional()
  place?: string;

  @IsArray()
  @IsOptional()
  labels?: string[];

  @IsString()
  @IsOptional()
  volume?: string;

  @IsString()
  @IsOptional()
  issue?: string;

  @IsString()
  @IsOptional()
  section?: string;

  @IsString()
  @IsOptional()
  pages?: string;

  @IsString()
  @IsOptional()
  url?: string;

  @IsString()
  @IsOptional()
  citationKey?: string;

  @IsString()
  @IsOptional()
  collectionId?: string;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  notes?: string[];
}

