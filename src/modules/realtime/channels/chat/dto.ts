import {
  IsArray,
  IsDefined,
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class ConversationRoomWsDto {
  @IsString()
  @IsNotEmpty()
  conversationId!: string;
}

export class ChatMessageContentWsDto {
  @IsString()
  @IsNotEmpty({ message: 'Message content cannot be empty' })
  content!: string;

  @IsOptional()
  @IsIn(['text', 'image', 'file', 'system'])
  type?: 'text' | 'image' | 'file' | 'system';

  @IsArray()
  @IsOptional()
  attachments?: unknown[];

  @IsUUID('all')
  @IsOptional()
  replyToId?: string;
}

export class SendMessageWsDto {
  @IsString()
  @IsNotEmpty()
  conversationId!: string;

  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => ChatMessageContentWsDto)
  dto!: ChatMessageContentWsDto;
}

export class TypingStartWsDto {
  @IsString()
  @IsNotEmpty()
  conversationId!: string;

  @IsString()
  @IsOptional()
  @MaxLength(100)
  userName?: string;
}

export class TypingStopWsDto {
  @IsString()
  @IsNotEmpty()
  conversationId!: string;

  @IsString()
  @IsOptional()
  @MaxLength(100)
  userName?: string;
}

export class MessageReadWsDto {
  @IsString()
  @IsNotEmpty()
  conversationId!: string;
}

export class MessageReactionWsDto {
  @IsString()
  @IsNotEmpty()
  messageId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  emoji!: string;

  @IsOptional()
  @IsIn(['add', 'remove'])
  action?: 'add' | 'remove';
}
