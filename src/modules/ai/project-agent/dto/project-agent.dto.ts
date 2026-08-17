import { IsArray, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class ProjectAgentQueryDto {
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

  @IsArray()
  @IsOptional()
  web_search_sites?: string[];

  @IsArray()
  @IsOptional()
  document_ids?: string[];

  @IsString()
  @IsOptional()
  selection?: string;

  @IsString()
  @IsOptional()
  cursor_context?: string;
}
