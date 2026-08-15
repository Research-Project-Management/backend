import { IsArray, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateChatDto {
  @IsString()
  @IsOptional()
  workspaceSlug?: string;

  @IsString()
  @IsOptional()
  workspaceId?: string;

  @IsString()
  @IsOptional()
  projectId?: string;

  @IsString()
  @IsOptional()
  pageId?: string;

  @IsString()
  @IsOptional()
  title?: string;
}

export class AppendMessagesDto {
  @IsArray()
  @IsNotEmpty({ message: 'Messages array is required' })
  messages!: Array<Record<string, unknown>>;
}

export class RenameChatDto {
  @IsString()
  @IsNotEmpty({ message: 'Title is required' })
  title!: string;
}
