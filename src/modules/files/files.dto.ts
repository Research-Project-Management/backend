import {
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

export class FilesPresignDto {
  @IsString()
  @IsNotEmpty({ message: 'Filename is required' })
  filename!: string;

  @IsString()
  @IsOptional()
  mimeType?: string;

  @IsString()
  @IsOptional()
  contentType?: string;

  @IsNumber()
  @Min(0)
  @IsOptional()
  sizeBytes?: number;

  @IsNumber()
  @Min(0)
  @IsOptional()
  size?: number;

  @IsString()
  @IsOptional()
  contentHash?: string;

  @IsString()
  @IsOptional()
  spaceId?: string;

  @IsString()
  @IsOptional()
  projectId?: string;
}

export class FilesCompletePresignDto {
  @IsString()
  @IsNotEmpty({ message: 'Storage key is required' })
  storageKey!: string;

  @IsString()
  @IsNotEmpty({ message: 'Filename is required' })
  filename!: string;

  @IsString()
  @IsOptional()
  mimeType?: string;

  @IsNumber()
  @Min(0)
  @IsOptional()
  sizeBytes?: number;

  @IsNumber()
  @Min(0)
  @IsOptional()
  size?: number;

  @IsString()
  @IsOptional()
  contentHash?: string;

  @IsString()
  @IsOptional()
  spaceId?: string;

  @IsString()
  @IsOptional()
  projectId?: string;
}
