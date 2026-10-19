import {
  IsString,
  IsNotEmpty,
  IsInt,
  IsOptional,
  IsArray,
  ValidateNested,
  Min,
  Max,
  MaxLength,
  ArrayMaxSize,
  IsUUID,
} from 'class-validator';
import { Type } from 'class-transformer';

// --- Inbound Client DTOs ---

export class JoinProjectDto {
  @IsUUID()
  @IsNotEmpty()
  projectId!: string;
}

export class JoinDocDto {
  @IsUUID()
  @IsNotEmpty()
  projectId!: string;

  @IsUUID()
  @IsNotEmpty()
  docId!: string;
}

export class LeaveDocDto {
  @IsUUID()
  @IsNotEmpty()
  projectId!: string;

  @IsUUID()
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
  @ArrayMaxSize(2000)
  @MaxLength(20000, { each: true })
  newLines!: string[];
}

export class SendUpdateDto {
  @IsUUID()
  @IsNotEmpty()
  projectId!: string;

  @IsUUID()
  @IsNotEmpty()
  docId!: string;

  @IsInt()
  @Min(0)
  clientRev!: number;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(2000)
  @MaxLength(20000, { each: true })
  lines?: string[];

  @IsOptional()
  @ValidateNested()
  @Type(() => LineSpliceDto)
  splice?: LineSpliceDto;

  @IsOptional()
  @IsInt()
  @Min(100)
  @Max(10000)
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
  @IsUUID()
  @IsNotEmpty()
  projectId!: string;

  @IsUUID()
  @IsNotEmpty()
  docId!: string;

  @ValidateNested()
  @Type(() => CursorPayloadDto)
  cursor!: CursorPayloadDto;
}

export class DocSyncDto {
  @IsUUID()
  @IsNotEmpty()
  projectId!: string;

  @IsUUID()
  @IsNotEmpty()
  docId!: string;

  @IsOptional()
  step?: string | number;

  @IsNotEmpty()
  data!: unknown;
}

export class ProjectChatSendDto {
  @IsUUID()
  @IsNotEmpty()
  projectId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(4000)
  text!: string;

  @IsOptional()
  @IsUUID()
  replyToId?: string;
}

export class ProjectChatHistoryDto {
  @IsUUID()
  @IsNotEmpty()
  projectId!: string;
}

// --- Outbound Server DTOs / Interfaces ---

export interface UserPresenceDto {
  userId: string;
  socketId: string;
  name: string;
  color: string;
  avatar: string | null;
  activeDocId: string | null;
  cursor: {
    row: number;
    column: number;
    selection: {
      anchor: { row: number; column: number };
      head: { row: number; column: number };
    } | null;
  } | null;
  lastSeenAt: string;
}
