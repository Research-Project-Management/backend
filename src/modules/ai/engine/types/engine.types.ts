export interface AiMessageDto {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface StreamChatPayload {
  messages: AiMessageDto[];
  user_id?: string;
  chat_id?: string | null;
  workspace_id?: string | null;
  project_id?: string | null;
  document_ids?: string[] | null;
  intent_hint?: string | null;
  web_search_sites?: string[] | null;
  selection?: string | null;
  cursor_context?: string | null;
  filename?: string | null;
  file_content?: string | null;
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
