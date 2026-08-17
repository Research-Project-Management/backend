import {
  IsArray,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
} from 'class-validator';

export class WritingAgentQueryDto {
  @IsArray()
  @IsNotEmpty({ message: 'Messages array is required' })
  messages!: Array<{
    role: 'user' | 'assistant' | 'system';
    content: string;
    [key: string]: unknown;
  }>;

  @IsString()
  @IsOptional()
  chat_id?: string;

  @IsString()
  @IsOptional()
  chatId?: string;

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
  page_id?: string;

  @IsString()
  @IsOptional()
  pageId?: string;

  @IsArray()
  @IsOptional()
  document_ids?: string[];

  @IsString()
  @IsOptional()
  filename?: string;

  @IsString()
  @IsOptional()
  file_content?: string;

  @IsString()
  @IsOptional()
  fileContent?: string;

  @IsString()
  @IsOptional()
  selection?: string;

  @IsString()
  @IsOptional()
  cursor_context?: string;

  @IsString()
  @IsOptional()
  cursorContext?: string;

  @IsNumber()
  @IsOptional()
  selection_start_line?: number;

  @IsNumber()
  @IsOptional()
  selectionStartLine?: number;

  @IsNumber()
  @IsOptional()
  selection_end_line?: number;

  @IsNumber()
  @IsOptional()
  selectionEndLine?: number;

  @IsNumber()
  @IsOptional()
  selection_start_column?: number;

  @IsNumber()
  @IsOptional()
  selectionStartColumn?: number;

  @IsNumber()
  @IsOptional()
  selection_end_column?: number;

  @IsNumber()
  @IsOptional()
  selectionEndColumn?: number;

  @IsString()
  @IsOptional()
  context_before?: string;

  @IsString()
  @IsOptional()
  contextBefore?: string;

  @IsString()
  @IsOptional()
  context_after?: string;

  @IsString()
  @IsOptional()
  contextAfter?: string;

  @IsString()
  @IsOptional()
  current_section?: string;

  @IsString()
  @IsOptional()
  currentSection?: string;

  @IsString()
  @IsOptional()
  current_environment?: string;

  @IsString()
  @IsOptional()
  currentEnvironment?: string;

  @IsString()
  @IsOptional()
  document_structure_summary?: string;

  @IsString()
  @IsOptional()
  documentStructureSummary?: string;

  @IsOptional()
  compile_errors?: unknown;
}
