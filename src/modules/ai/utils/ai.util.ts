import { AiQueryDto } from '../dto/ai.dto';
import { AiEnginePayload } from '../types/ai.types';
import { AiMessageDto } from '../engine/types/engine.types';

/**
 * Sanitizes chat thread titles by stripping HTML tags, scripts,
 * and control characters, truncating to a safe length.
 */
export function sanitizeChatTitle(rawTitle?: string | null): string {
  if (!rawTitle) return 'New Chat';
  const sanitized = rawTitle
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<[^>]*>/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1F\x7F]/g, '')
    .trim();
  return sanitized.length > 0 ? sanitized.slice(0, 100) : 'New Chat';
}

/**
 * Sanitizes message content by stripping null bytes and unprintable control characters
 * while preserving valid tabs and newlines, bounded to max 50,000 characters.
 */
export function sanitizeChatMessageContent(rawContent?: string | null): string {
  if (!rawContent) return '';
  return (
    rawContent
      .replace(/\0/g, '')
      // eslint-disable-next-line no-control-regex
      .replace(/[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
      .trim()
      .slice(0, 50000)
  );
}

/**
 * Enforces role security: client-submitted messages cannot claim 'system' role
 * unless explicitly authorized. Maps arbitrary/invalid roles to 'user'.
 */
export function validateAndSanitizeRole(role?: string): 'user' | 'assistant' {
  if (role === 'assistant') return 'assistant';
  return 'user';
}

/**
 * Normalizes input messages from DTO, handling both `messages` array and fallback `query` string.
 */
export function normalizeMessages(dto: AiQueryDto): AiMessageDto[] {
  if (Array.isArray(dto.messages) && dto.messages.length > 0) {
    return dto.messages.map((m) => ({
      role: validateAndSanitizeRole(m.role),
      content: sanitizeChatMessageContent(m.content),
    }));
  }
  if (dto.query && dto.query.trim()) {
    return [
      {
        role: 'user',
        content: sanitizeChatMessageContent(dto.query),
      },
    ];
  }
  return [{ role: 'user', content: '' }];
}

/**
 * Extracts and unifies document IDs across camelCase and snake_case properties.
 */
export function extractDocIds(dto: AiQueryDto): string[] {
  return dto.document_ids || dto.documentIds || dto.selected_files || [];
}

/**
 * Assembles a standardized AI Engine payload from user context and DTO.
 */
export function buildAiPayload(
  userId: string,
  dto: AiQueryDto,
): AiEnginePayload {
  const messages = normalizeMessages(dto);
  const documentIds = extractDocIds(dto);
  const scopeId = dto.project_id || dto.projectId || userId;
  const projectId = dto.project_id || dto.projectId || '';
  const chatId = dto.chat_id || dto.chatId || '';

  return {
    messages,
    user_id: userId,
    workspace_id: scopeId,
    project_id: projectId,
    chat_id: chatId,
    document_ids: documentIds,
    web_search_sites: dto.web_search_sites || dto.webSearchSites || [],
    intent_hint: dto.intent_hint || dto.intentHint || undefined,
    // Editor / Writing Context with length safety guards
    filename: dto.filename || 'document.tex',
    file_content: (dto.file_content || dto.fileContent || '').slice(0, 100000),
    selection: (dto.selection || '').slice(0, 20000),
    cursor_context: (dto.cursor_context || dto.cursorContext || '').slice(
      0,
      10000,
    ),
    cursor_line: dto.cursor_line ?? dto.cursorLine ?? 1,
    cursor_column: dto.cursor_column ?? dto.cursorColumn ?? 1,
    selection_start_line: dto.selection_start_line ?? dto.selectionStartLine,
    selection_start_column:
      dto.selection_start_column ?? dto.selectionStartColumn,
    selection_end_line: dto.selection_end_line ?? dto.selectionEndLine,
    selection_end_column: dto.selection_end_column ?? dto.selectionEndColumn,
    document_structure: (
      dto.document_structure ||
      dto.documentStructure ||
      ''
    ).slice(0, 10000),
  };
}

/**
 * Formats paper metadata into a clean grounding context for paper-scoped RAG.
 */
export function formatPaperContext(paper: {
  title?: string;
  authors?: string[] | string;
  year?: number | string;
  doi?: string;
  abstract?: string;
}): string {
  const authorsStr = Array.isArray(paper.authors)
    ? paper.authors.join(', ')
    : paper.authors || '';
  return `Paper Context: Title: "${paper.title || 'Untitled'}", Authors: "${authorsStr}", Year: ${paper.year || 'N/A'}, DOI: ${paper.doi || 'N/A'}.\nAbstract: ${paper.abstract || 'N/A'}`;
}
