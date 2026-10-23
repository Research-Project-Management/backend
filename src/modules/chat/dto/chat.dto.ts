import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsEnum,
  IsArray,
  IsUUID,
} from 'class-validator';
import { MessageType } from '@prisma/client';

export class CreateDirectConversationDto {
  @IsUUID()
  @IsNotEmpty()
  targetUserId!: string;
}

export class CreateGroupConversationDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsString()
  @IsOptional()
  avatar?: string;

  @IsArray()
  @IsUUID('all', { each: true })
  @IsOptional()
  memberIds?: string[];
}

export class CreateProjectChannelDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsString()
  @IsOptional()
  topic?: string;
}

export class SendMessageDto {
  @IsString()
  @IsNotEmpty()
  content!: string;

  @IsEnum(MessageType)
  @IsOptional()
  type?: MessageType;

  @IsArray()
  @IsOptional()
  attachments?: unknown[];

  @IsUUID()
  @IsOptional()
  replyToId?: string;
}

export class AddReactionDto {
  @IsString()
  @IsNotEmpty()
  emoji!: string;
}

export class GetMessagesQueryDto {
  @IsString()
  @IsOptional()
  cursor?: string;

  @IsOptional()
  limit?: string;
}
