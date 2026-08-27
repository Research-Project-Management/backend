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

  @IsString()
  @IsOptional()
  projectId?: string;

  @IsString()
  @IsOptional()
  workspaceId?: string;
}

export class UpdateCommentDto {
  @IsString()
  @IsOptional()
  content?: string;

  @IsEnum(CommentStatus)
  @IsOptional()
  status?: CommentStatus;

  @IsString()
  @IsOptional()
  projectId?: string;

  @IsString()
  @IsOptional()
  workspaceId?: string;
}

export class AddReplyDto {
  @IsString()
  @IsNotEmpty({ message: 'Reply content is required' })
  content!: string;

  @IsString()
  @IsOptional()
  projectId?: string;

  @IsString()
  @IsOptional()
  workspaceId?: string;
}
