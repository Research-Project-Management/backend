import {
  ArrayMaxSize,
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
import { MAX_PART_PRESIGN_BATCH } from './files.constant';

export class FilesPresignDto {
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

  @IsString()
  @IsOptional()
  contentHash?: string;

  @IsString()
  @IsOptional()
  spaceId?: string;
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

  @IsString()
  @IsOptional()
  contentHash?: string;

  @IsString()
  @IsOptional()
  spaceId?: string;
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

  @IsString()
  @IsOptional()
  expectedHash?: string;

  @IsString()
  @IsOptional()
  spaceId?: string;
}

export class FilesBatchPartUrlsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_PART_PRESIGN_BATCH)
  @IsInt({ each: true })
  @Min(1, { each: true })
  partNumbers!: number[];
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
