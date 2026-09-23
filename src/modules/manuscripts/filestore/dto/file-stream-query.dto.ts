/**
 * filestore/dto/file-stream-query.dto.ts
 */

import { IsOptional, IsString } from 'class-validator';

export class FileStreamQueryDto {
  @IsOptional()
  @IsString()
  format?: string;

  @IsOptional()
  @IsString()
  style?: string; // 'thumbnail' | 'preview'
}
