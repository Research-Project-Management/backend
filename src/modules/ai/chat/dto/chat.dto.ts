import { IsArray, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateChatDto {
  @IsString()
  @IsOptional()
  projectId?: string;

  @IsString()
  @IsOptional()
  pageId?: string;

  @IsString()
  @IsOptional()
  title?: string;

  @IsArray()
  @IsOptional()
  messages?: Array<Record<string, unknown>>;

  @IsArray()
  @IsOptional()
  documentIds?: string[];
}

// Backward compatibility alias
export class CreateThreadDto extends CreateChatDto {}

export class AppendMessagesDto {
  @IsArray()
  @IsNotEmpty({ message: 'Messages array is required' })
  messages!: Array<Record<string, unknown>>;

  @IsArray()
  @IsOptional()
  documentIds?: string[];

  @IsString()
  @IsOptional()
  projectId?: string;
}

export class RenameChatDto {
  @IsString()
  @IsNotEmpty({ message: 'Title is required' })
  title!: string;

  @IsString()
  @IsOptional()
  projectId?: string;
}

// Backward compatibility alias
export class RenameThreadDto extends RenameChatDto {}
