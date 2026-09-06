import { IsString, IsOptional, IsNumber } from 'class-validator';

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
