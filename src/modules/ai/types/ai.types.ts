import type { AiMessageDto } from '../engine/types/engine.types';

export interface ProjectSessionContext {
  projectId?: string;
  chatId?: string;
  pageId?: string;
}

export interface DocumentContext {
  documentIds?: string[];
  selectedFiles?: string[];
  webSearchSites?: string[];
}

export interface EditorWritingContext {
  filename?: string;
  fileContent?: string;
  selection?: string;
  cursorContext?: string;
  cursorLine?: number;
  cursorColumn?: number;
  selectionStartLine?: number;
  selectionStartColumn?: number;
  selectionEndLine?: number;
  selectionEndColumn?: number;
  documentStructure?: string;
}

export interface AiEnginePayload {
  messages: AiMessageDto[];
  user_id: string;
  space_id?: string;
  workspace_id?: string;
  project_id: string | null;
  chat_id: string;
  page_id?: string | null;
  document_ids: string[];
  web_search_sites?: string[];
  intent_hint?: string;
  filename: string;
  file_content: string;
  selection: string;
  user_selection?: unknown;
  cursor_context: string;
  cursor_line: number;
  cursor_column: number;
  selection_start_line?: number;
  selection_start_column?: number;
  selection_end_line?: number;
  selection_end_column?: number;
  context_before?: string;
  context_after?: string;
  current_section?: string;
  current_environment?: string;
  document_structure_summary?: string;
  compile_errors?: unknown;
  document_structure: string;
  use_rag?: boolean;
  context?: Record<string, unknown>;
  [key: string]: unknown;
}
