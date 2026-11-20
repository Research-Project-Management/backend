import {
  IsString,
  IsNotEmpty,
  IsInt,
  IsOptional,
  ValidateNested,
  Min,
  IsUUID,
} from 'class-validator';
import { Type } from 'class-transformer';

// --- Inbound Client DTOs ---

export class JoinProjectDto {
  @IsString()
  @IsNotEmpty()
  spaceId!: string;
}

export class JoinDocDto {
  @IsString()
  @IsNotEmpty()
  spaceId!: string;

  @IsUUID()
  @IsNotEmpty()
  docId!: string;
}

export class LeaveDocDto {
  @IsString()
  @IsNotEmpty()
  spaceId!: string;

  @IsUUID()
  @IsNotEmpty()
  docId!: string;
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
  spaceId!: string;

  @IsUUID()
  @IsNotEmpty()
  docId!: string;

  @ValidateNested()
  @Type(() => CursorPayloadDto)
  cursor!: CursorPayloadDto;
}

export class DocSyncDto {
  @IsString()
  @IsNotEmpty()
  spaceId!: string;

  @IsUUID()
  @IsNotEmpty()
  docId!: string;

  @IsOptional()
  step?: string | number;

  @IsNotEmpty()
  data!: unknown;
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
