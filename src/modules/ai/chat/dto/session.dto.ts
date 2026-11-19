import { Type } from 'class-transformer';
import {
  Allow,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

export class SessionMessageInputDto {
  @IsIn(['user', 'assistant', 'system'])
  role!: 'user' | 'assistant' | 'system';

  @IsString()
  content!: string;

  @IsOptional()
  @Allow()
  attachments?: unknown;

  @IsOptional()
  @Allow()
  sources?: unknown;

  @IsOptional()
  @Allow()
  widgets?: unknown;

  @IsOptional()
  @Allow()
  selectionContext?: unknown;
}

export class CreateSessionDto {
  @IsString()
  @IsOptional()
  spaceId?: string;

  @IsString()
  @IsOptional()
  pageId?: string;

  @IsString()
  @IsOptional()
  title?: string;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  documentIds?: string[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SessionMessageInputDto)
  @IsOptional()
  messages?: SessionMessageInputDto[];
}

export class AppendMessagesDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SessionMessageInputDto)
  messages!: SessionMessageInputDto[];

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  documentIds?: string[];
}

export class RenameSessionDto {
  @IsString()
  @IsNotEmpty()
  title!: string;
}
