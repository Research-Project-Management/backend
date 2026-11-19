import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsObject,
  IsInt,
  Min,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';

export class CreateNotificationDto {
  @IsString()
  @IsNotEmpty()
  userId!: string;

  @IsString()
  @IsOptional()
  key?: string;

  @IsString()
  @IsNotEmpty()
  templateKey!: string;

  @IsString()
  @IsOptional()
  type?: string;

  @IsString()
  @IsOptional()
  spaceId?: string;

  @IsString()
  @IsOptional()
  projectId?: string;

  @IsString()
  @IsOptional()
  docId?: string;

  @IsString()
  @IsOptional()
  actorId?: string;

  @IsObject()
  @IsOptional()
  messageOpts?: Record<string, unknown>;

  @IsString()
  @IsOptional()
  expiresAt?: string;

  @IsBoolean()
  @IsOptional()
  forceCreate?: boolean;
}

export class QueryNotificationsDto {
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => {
    if (value === 'true' || value === true) return true;
    if (value === 'false' || value === false) return false;
    return undefined;
  })
  isRead?: boolean;

  @IsOptional()
  @IsString()
  type?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  limit?: number = 50;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  offset?: number = 0;
}

export class ParseMentionsDto {
  @IsString()
  @IsNotEmpty()
  text!: string;

  @IsString()
  @IsOptional()
  actorId?: string;

  @IsString()
  @IsOptional()
  actorName?: string;

  @IsString()
  @IsOptional()
  spaceId?: string;

  @IsString()
  @IsOptional()
  projectId?: string;

  @IsString()
  @IsOptional()
  pageId?: string;

  @IsString()
  @IsOptional()
  projectName?: string;

  @IsString()
  @IsOptional()
  docId?: string;

  @IsString()
  @IsOptional()
  threadId?: string;

  @IsString()
  @IsOptional()
  commentId?: string;

  @IsObject()
  @IsOptional()
  collaboratorMap?: Record<string, string>;
}
