export interface AiMessageDto {
  role: 'user' | 'assistant' | 'system';
  content: string;
  attachments?: unknown;
  sources?: unknown;
  [key: string]: unknown;
}

export interface StreamChatPayload {
  messages: AiMessageDto[];
  user_id?: string;
  space_id?: string | null;
  workspace_id?: string | null;
  project_id?: string | null;
  chat_id?: string | null;
  page_id?: string | null;
  document_ids?: string[] | null;
  intent_hint?: string | null;
  web_search_sites?: string[] | null;
  selection?: string | null;
  user_selection?: unknown;
  cursor_context?: string | null;
  context_before?: string | null;
  context_after?: string | null;
  current_section?: string | null;
  current_environment?: string | null;
  document_structure_summary?: string | null;
  compile_errors?: unknown;
  filename?: string | null;
  file_content?: string | null;
  context?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface SyncChatResponse {
  role: 'assistant';
  content: string;
  sources?: Array<{
    title?: string;
    url?: string;
    source?: string;
    snippet?: string;
    year?: number;
    authors?: string;
  }>;
  widgets?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}
export interface StreamChatOptions {
  initialEvents?: string[];
  onComplete?: (accumulatedText: string) => Promise<void> | void;
}
