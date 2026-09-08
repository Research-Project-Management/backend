import type { AiMessageDto } from '../engine/types/engine.types';

/** @deprecated Use AiMessageDto instead */
export interface AiMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  [key: string]: unknown;
}

export interface WorkspaceSessionContext {
  workspaceId?: string;
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
  workspace_id: string;
  project_id: string;
  chat_id: string;
  document_ids: string[];
  web_search_sites?: string[];
  intent_hint?: string;
  filename: string;
  file_content: string;
  selection: string;
  cursor_context: string;
  cursor_line: number;
  cursor_column: number;
  selection_start_line?: number;
  selection_start_column?: number;
  selection_end_line?: number;
  selection_end_column?: number;
  document_structure: string;
  [key: string]: unknown;
}
