import {
  IsArray,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
} from 'class-validator';

export class AiMessageDto {
  @IsString()
  role!: 'user' | 'assistant' | 'system';

  @IsString()
  content!: string;

  [key: string]: unknown;
}

export class AiQueryDto {
  @IsArray()
  @IsOptional()
  messages?: AiMessageDto[];

  @IsString()
  @IsOptional()
  query?: string;

  // ── Session & Workspace Context ──────────────────────────────────────────
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
  page_id?: string;

  @IsString()
  @IsOptional()
  pageId?: string;

  // ── Document & RAG Context ───────────────────────────────────────────────
  @IsArray()
  @IsOptional()
  document_ids?: string[];

  @IsArray()
  @IsOptional()
  documentIds?: string[];

  @IsArray()
  @IsOptional()
  selected_files?: string[];

  @IsArray()
  @IsOptional()
  web_search_sites?: string[];

  @IsArray()
  @IsOptional()
  webSearchSites?: string[];

  // ── Editor / Writing Context ─────────────────────────────────────────────
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
  cursor_line?: number;

  @IsNumber()
  @IsOptional()
  cursorLine?: number;

  @IsNumber()
  @IsOptional()
  cursor_column?: number;

  @IsNumber()
  @IsOptional()
  cursorColumn?: number;

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
  document_structure?: string;

  @IsString()
  @IsOptional()
  documentStructure?: string;

  // ── Intent Hint ───────────────────────────────────────────────────────────
  @IsString()
  @IsOptional()
  intent_hint?: string;

  @IsString()
  @IsOptional()
  intentHint?: string;

  [key: string]: unknown;
}

export class BulkDocumentsDto {
  @IsArray()
  @IsOptional()
  ids?: string[];
}

export class GetDocumentsBulkDto {
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  ids?: string[];

  @IsString()
  @IsNotEmpty({ message: 'workspaceId is required' })
  workspaceId!: string;
}
