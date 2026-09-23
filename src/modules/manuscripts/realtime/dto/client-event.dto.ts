/**
 * realtime/dto/client-event.dto.ts
 * Inbound WebSocket request payloads from collaborating editor clients.
 */

import { IsString, IsNotEmpty, IsInt, IsOptional, IsArray, ValidateNested, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class JoinProjectDto {
  @IsString()
  @IsNotEmpty()
  projectId!: string;
}

export class JoinDocDto {
  @IsString()
  @IsNotEmpty()
  projectId!: string;

  @IsString()
  @IsNotEmpty()
  docId!: string;
}

export class LeaveDocDto {
  @IsString()
  @IsNotEmpty()
  projectId!: string;

  @IsString()
  @IsNotEmpty()
  docId!: string;
}

export class LineSpliceDto {
  @IsInt()
  @Min(0)
  startLine!: number;

  @IsInt()
  @Min(0)
  deleteCount!: number;

  @IsArray()
  @IsString({ each: true })
  newLines!: string[];
}

export class SendUpdateDto {
  @IsString()
  @IsNotEmpty()
  projectId!: string;

  @IsString()
  @IsNotEmpty()
  docId!: string;

  @IsInt()
  @Min(0)
  clientRev!: number;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  lines?: string[];

  @IsOptional()
  @ValidateNested()
  @Type(() => LineSpliceDto)
  splice?: LineSpliceDto;

  @IsOptional()
  @IsInt()
  @Min(100)
  debounceMs?: number;
}

export class CursorPointDto {
  @IsInt()
  @Min(0)
  row!: number;

  @IsInt()
  @Min(0)
  column!: number;
}

export class CursorSelectionDto {
  @ValidateNested()
  @Type(() => CursorPointDto)
  anchor!: CursorPointDto;

  @ValidateNested()
  @Type(() => CursorPointDto)
  head!: CursorPointDto;
}

export class CursorPayloadDto {
  @IsInt()
  @Min(0)
  row!: number;

  @IsInt()
  @Min(0)
  column!: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => CursorSelectionDto)
  selection?: CursorSelectionDto | null;
}

export class CursorUpdateDto {
  @IsString()
  @IsNotEmpty()
  projectId!: string;

  @IsString()
  @IsNotEmpty()
  docId!: string;

  @ValidateNested()
  @Type(() => CursorPayloadDto)
  cursor!: CursorPayloadDto;
}
