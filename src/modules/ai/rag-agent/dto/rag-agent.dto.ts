import { IsArray, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class RagAgentQueryDto {
  @IsString()
  @IsNotEmpty({ message: 'Query or messages are required' })
  @IsOptional()
  query?: string;

  @IsArray()
  @IsOptional()
  messages?: Array<{
    role: 'user' | 'assistant' | 'system';
    content: string;
    [key: string]: unknown;
  }>;

  @IsArray()
  @IsOptional()
  document_ids?: string[];

  @IsArray()
  @IsOptional()
  documentIds?: string[];

  @IsArray()
  @IsOptional()
  selected_files?: string[];

  @IsString()
  @IsOptional()
  workspace_id?: string;

  @IsString()
  @IsOptional()
  workspaceId?: string;

  @IsString()
  @IsOptional()
  project_id?: string;

  @IsString()
  @IsOptional()
  projectId?: string;

  @IsString()
  @IsOptional()
  chat_id?: string;

  @IsString()
  @IsOptional()
  chatId?: string;

  @IsString()
  @IsOptional()
  intent_hint?: string;
}

export class BulkDocumentsDto {
  @IsArray()
  @IsOptional()
  ids?: string[];
}
