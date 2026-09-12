import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateCommentDto {
  @IsString()
  @IsNotEmpty({ message: 'Comment content is required' })
  content!: string;

  @IsString()
  @IsOptional()
  projectId?: string;

  @IsOptional()
  attachments?: any[];
}

export class UpdateCommentDto {
  @IsString()
  @IsOptional()
  content?: string;

  @IsString()
  @IsOptional()
  projectId?: string;

  @IsOptional()
  attachments?: any[];
}

export class AddReplyDto {
  @IsString()
  @IsNotEmpty({ message: 'Reply content is required' })
  content!: string;

  @IsString()
  @IsOptional()
  projectId?: string;
}

export class ReactCommentDto {
  @IsString()
  @IsNotEmpty({ message: 'Emoji is required' })
  emoji!: string;

  @IsString()
  @IsOptional()
  projectId?: string;
}
