import {
  IsArray,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MessageType } from '@prisma/client';

export class SendMessageDto {
  @ApiProperty({
    description: 'Message text content',
    example: 'Hello everyone, I have uploaded the updated draft!',
  })
  @IsString()
  @IsNotEmpty({ message: 'Message content cannot be empty' })
  content!: string;

  @ApiPropertyOptional({
    description: 'Message type',
    enum: MessageType,
    default: MessageType.text,
  })
  @IsEnum(MessageType)
  @IsOptional()
  type?: MessageType;

  @ApiPropertyOptional({
    description: 'List of attachments (stored in S3/MinIO)',
    example: [
      {
        name: 'paper.pdf',
        url: 'https://...',
        size: 1024,
        mimeType: 'application/pdf',
      },
    ],
  })
  @IsArray()
  @IsOptional()
  attachments?: unknown[];

  @ApiPropertyOptional({
    description: 'Optional parent message ID to reply to',
    example: '01957c91-2345-7890-abcd-ef0123456789',
  })
  @IsUUID('all')
  @IsOptional()
  replyToId?: string;
}
