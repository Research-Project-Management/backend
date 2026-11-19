import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

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

export class FilesInitiateMultipartDto {
  @IsString()
  @IsNotEmpty({ message: 'Filename is required' })
  filename!: string;

  @IsString()
  @IsOptional()
  mimeType?: string;

  @IsNumber()
  @Min(1)
  @IsOptional()
  totalSize?: number;

  @IsNumber()
  @Min(1)
  @IsOptional()
  sizeBytes?: number;

  @IsNumber()
  @Min(1)
  @IsOptional()
  size?: number;

  @IsString()
  @IsOptional()
  expectedHash?: string;

  @IsString()
  @IsOptional()
  spaceId?: string;

  @IsString()
  @IsOptional()
  projectId?: string;
}

export class FilesMultipartPartUrlDto {
  @IsString()
  @IsNotEmpty({ message: 'Session ID is required' })
  sessionId!: string;

  @IsInt()
  @Min(1)
  partNumber!: number;
}

export class FilesMultipartPartDto {
  @IsInt()
  @Min(1)
  partNumber!: number;

  @IsString()
  @IsNotEmpty({ message: 'Part ETag is required' })
  eTag!: string;
}

export class FilesCompleteMultipartDto {
  @IsString()
  @IsNotEmpty({ message: 'Session ID is required' })
  sessionId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => FilesMultipartPartDto)
  parts!: FilesMultipartPartDto[];
}
