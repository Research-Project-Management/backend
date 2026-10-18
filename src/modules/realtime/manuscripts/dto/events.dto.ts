import {
  IsString,
  IsNotEmpty,
  IsInt,
  IsOptional,
  IsArray,
  ValidateNested,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

// --- Inbound Client DTOs ---

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

export class DocSyncDto {
  @IsString()
  @IsNotEmpty()
  projectId!: string;

  @IsString()
  @IsNotEmpty()
  docId!: string;

  @IsOptional()
  step?: string | number;

  @IsNotEmpty()
  data!: unknown;
}

export class ProjectChatSendDto {
  @IsString()
  @IsNotEmpty()
  projectId!: string;

  @IsString()
  @IsNotEmpty()
  text!: string;

  @IsOptional()
  @IsString()
  replyToId?: string;
}

export class ProjectChatHistoryDto {
  @IsString()
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

export interface DocUpdateAckDto {
  docId: string;
  clientRev: number;
  serverRev: number;
  version: number;
  inFlightSeq: number;
}

export interface DocUpdateBroadcastDto {
  docId: string;
  clientRev: number;
  serverRev: number;
  version: number;
  inFlightSeq: number;
  lines?: string[] | null;
  splice?: {
    startLine: number;
    deleteCount: number;
    newLines: string[];
  } | null;
  userId: string;
}

export interface ProjectUserJoinedDto {
  userId: string;
  socketId: string;
  name: string;
  color: string;
  avatar: string | null;
}

export interface ProjectUserLeftDto {
  userId: string;
  socketId: string;
}
