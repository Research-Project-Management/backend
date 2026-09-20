import { IsString, IsOptional, IsNumber, IsArray } from 'class-validator';

export class CreateAttachmentDto {
  @IsString()
  filename!: string;

  @IsString()
  url!: string;

  @IsString()
  @IsOptional()
  mimeType?: string;

  @IsNumber()
  @IsOptional()
  size?: number;

  @IsString()
  @IsOptional()
  fileHash?: string;

  @IsString()
  @IsOptional()
  fileId?: string;
}

export class ReplaceAttachmentFileDto {
  @IsString()
  url!: string;

  @IsString()
  fileHash!: string;

  @IsNumber()
  sizeBytes!: number;

  @IsString()
  @IsOptional()
  comment?: string;
}

export class RenameAttachmentDto {
  @IsString()
  @IsOptional()
  filename?: string;

  @IsString()
  @IsOptional()
  pattern?: string;
}

export class BatchRenameAttachmentsDto {
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  itemIds?: string[];

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  attachmentIds?: string[];

  @IsString()
  @IsOptional()
  pattern?: string;
}
