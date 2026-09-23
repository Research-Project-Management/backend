/**
 * document-updater/dto/queue-update.dto.ts
 */

import { IsArray, IsInt, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class SpliceUpdateDto {
  @IsInt()
  startLine!: number;

  @IsInt()
  deleteCount!: number;

  @IsArray()
  @IsString({ each: true })
  newLines!: string[];
}

export class QueueUpdateDto {
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  lines?: string[];

  @IsOptional()
  @ValidateNested()
  @Type(() => SpliceUpdateDto)
  splice?: SpliceUpdateDto;

  @IsOptional()
  @IsString()
  userId?: string;

  @IsOptional()
  @IsInt()
  clientRev?: number;

  @IsOptional()
  @IsInt()
  debounceMs?: number;
}
