import {
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
} from 'class-validator';
import { CommentStatus } from '@prisma/client';

export class CreatePageCommentDto {
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

export class UpdatePageCommentDto {
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

export class CreateTaskCommentDto {
  @IsString()
  @IsNotEmpty({ message: 'Comment content is required' })
  content!: string;
}

export class UpdateTaskCommentDto {
  @IsString()
  @IsOptional()
  content?: string;
}

export class ReactTaskCommentDto {
  @IsString()
  @IsNotEmpty({ message: 'Emoji is required' })
  emoji!: string;
}
