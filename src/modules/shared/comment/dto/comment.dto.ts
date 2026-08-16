import {
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
} from 'class-validator';
import { CommentStatus } from '@prisma/client';

export class CreateCommentDto {
  @IsString()
  @IsNotEmpty({ message: 'Comment content is required' })
  content!: string;

  @IsEnum(CommentStatus)
  @IsOptional()
  status?: CommentStatus;

  @IsNumber()
  @IsOptional()
  line?: number;

  @IsNumber()
  @IsOptional()
  lineEnd?: number;
}

export class UpdateCommentDto {
  @IsString()
  @IsOptional()
  content?: string;

  @IsEnum(CommentStatus)
  @IsOptional()
  status?: CommentStatus;
}

export class AddReplyDto {
  @IsString()
  @IsNotEmpty({ message: 'Reply content is required' })
  content!: string;
}

export class ReactCommentDto {
  @IsString()
  @IsNotEmpty({ message: 'Emoji is required' })
  emoji!: string;
}
