import { IsArray, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export interface IncomingChatMessage {
  role?: string;
  content?: string;
  sources?: unknown;
  attachments?: unknown;
  widgets?: unknown;
  selectionContext?: unknown;
  [key: string]: unknown;
}

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
  messages?: IncomingChatMessage[];

  @IsArray()
  @IsOptional()
  documentIds?: string[];
}

// Backward compatibility alias
export class CreateThreadDto extends CreateChatDto {}

export class AppendMessagesDto {
  @IsArray()
  @IsNotEmpty({ message: 'Messages array is required' })
  messages!: IncomingChatMessage[];

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
