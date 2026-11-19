import {
  Allow,
  IsArray,
  IsBoolean,
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

  @IsOptional()
  attachments?: unknown;

  @IsOptional()
  sources?: unknown;

  [key: string]: unknown;
}

export class AiQueryDto {
  @IsArray()
  @IsOptional()
  messages?: AiMessageDto[];

  @IsString()
  @IsOptional()
  query?: string;

  // ── Session & Project Context ──────────────────────────────────────────

  @IsString()
  @IsOptional()
  space_id?: string;

  @IsString()
  @IsOptional()
  spaceId?: string;

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

  @IsOptional()
  @Allow()
  document_structure?: string | Record<string, unknown>[];

  @IsOptional()
  @Allow()
  documentStructure?: string | Record<string, unknown>[];

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
  @Allow()
  user_selection?: string | Record<string, unknown>;

  @IsOptional()
  @Allow()
  userSelection?: string | Record<string, unknown>;

  @IsOptional()
  @Allow()
  compile_errors?: unknown;

  @IsOptional()
  @Allow()
  compileErrors?: unknown;

  @IsBoolean()
  @IsOptional()
  use_rag?: boolean;

  @IsBoolean()
  @IsOptional()
  useRag?: boolean;

  // ── Intent Hint ───────────────────────────────────────────────────────────
  @IsString()
  @IsOptional()
  intent_hint?: string;

  @IsString()
  @IsOptional()
  intentHint?: string;

  [key: string]: unknown;
}

export class GetDocumentsBulkDto {
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  ids?: string[];

  @IsString()
  @IsOptional()
  spaceId?: string;
}
