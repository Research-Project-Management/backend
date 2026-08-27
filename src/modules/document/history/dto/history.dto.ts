import { IsEnum, IsOptional, IsString } from 'class-validator';
import { VersionEventType } from '@prisma/client';

export class CreateVersionDto {
  @IsString()
  @IsOptional()
  title?: string;

  @IsString()
  @IsOptional()
  content?: string;

  @IsString()
  @IsOptional()
  label?: string;

  @IsEnum(VersionEventType)
  @IsOptional()
  eventType?: VersionEventType;

  @IsString()
  @IsOptional()
  fileName?: string;

  @IsString()
  @IsOptional()
  projectPageId?: string;

  @IsString()
  @IsOptional()
  projectId?: string;

  @IsString()
  @IsOptional()
  workspaceId?: string;
}
