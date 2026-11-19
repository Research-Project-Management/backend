import { isUUID } from 'class-validator';
import { AiQueryDto } from '../dto/ai.dto';
import { AiEnginePayload } from '../types/ai.types';
import { AiMessageDto } from '../engine/types/engine.types';

const NON_PROJECT_KEYWORDS = new Set([
  'me',
  'user',
  'personal',
  'all',
  'undefined',
  'null',
  'default',
]);

/**
 * Normalizes a project/scope ID, returning undefined for personal/non-project keywords.
 */
export function normalizeProjectId(
  value: unknown,
  userId?: string | null,
): string | undefined {
  if (!value || typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || NON_PROJECT_KEYWORDS.has(trimmed.toLowerCase())) {
    return undefined;
  }
  if (
    userId &&
    typeof userId === 'string' &&
    trimmed.toLowerCase() === userId.trim().toLowerCase()
  ) {
    return undefined;
  }
  return trimmed;
}

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validates and normalizes project ID as UUID, ignoring personal scope keywords like 'me', 'personal'.
 */
export function toValidProjectId(
  value: unknown,
  userId?: string | null,
): string | undefined {
  const normalized = normalizeProjectId(value, userId);
  if (!normalized) return undefined;
  return UUID_REGEX.test(normalized) ? normalized : undefined;
}

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
      ...(m.attachments !== undefined ? { attachments: m.attachments } : {}),
      ...(m.sources !== undefined ? { sources: m.sources } : {}),
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
  resolved?: {
    spaceId?: string;
    projectId?: string | null;
    pageId?: string | null;
  },
): AiEnginePayload {
  const messages = normalizeMessages(dto);
  const documentIds = extractDocIds(dto);
  const inferredProjectId =
    toValidProjectId(dto.space_id || dto.spaceId, userId) ?? null;
  const validProjectId =
    resolved && resolved.projectId !== undefined
      ? resolved.projectId
      : inferredProjectId;
  const scopeId = resolved?.spaceId || validProjectId || userId;
  const projectId = validProjectId || null;
  const chatId = dto.chat_id || dto.chatId || '';
  const pageId = resolved?.pageId || dto.page_id || dto.pageId || null;

  const rawDocStructure = dto.document_structure ?? dto.documentStructure;
  const documentStructure = (
    typeof rawDocStructure === 'string'
      ? rawDocStructure
      : Array.isArray(rawDocStructure) ||
          (rawDocStructure && typeof rawDocStructure === 'object')
        ? JSON.stringify(rawDocStructure)
        : ''
  ).slice(0, 10000);

  const fileContent = (dto.file_content || dto.fileContent || '').slice(
    0,
    100000,
  );
  const selection = (dto.selection || '').slice(0, 20000);
  const userSelection = dto.user_selection ?? dto.userSelection;
  const cursorContext = (dto.cursor_context || dto.cursorContext || '').slice(
    0,
    10000,
  );
  const contextBefore = (dto.context_before || dto.contextBefore || '').slice(
    0,
    15000,
  );
  const contextAfter = (dto.context_after || dto.contextAfter || '').slice(
    0,
    15000,
  );
  const currentSection = (
    dto.current_section ||
    dto.currentSection ||
    ''
  ).slice(0, 1000);
  const currentEnvironment = (
    dto.current_environment ||
    dto.currentEnvironment ||
    ''
  ).slice(0, 500);
  const documentStructureSummary = (
    dto.document_structure_summary ||
    dto.documentStructureSummary ||
    ''
  ).slice(0, 10000);
  const compileErrors = dto.compile_errors ?? dto.compileErrors;
  const webSearchSites = dto.web_search_sites || dto.webSearchSites || [];
  const useRag = dto.use_rag ?? dto.useRag;
  const filename = dto.filename || 'document.tex';
  const cursorLine = dto.cursor_line ?? dto.cursorLine ?? 1;
  const cursorColumn = dto.cursor_column ?? dto.cursorColumn ?? 1;
  const selectionStartLine = dto.selection_start_line ?? dto.selectionStartLine;
  const selectionStartColumn =
    dto.selection_start_column ?? dto.selectionStartColumn;
  const selectionEndLine = dto.selection_end_line ?? dto.selectionEndLine;
  const selectionEndColumn = dto.selection_end_column ?? dto.selectionEndColumn;

  const context: Record<string, unknown> = {
    filename,
    cursor_line: cursorLine,
    cursor_column: cursorColumn,
  };
  if (pageId) context.page_id = pageId;
  if (fileContent) context.file_content = fileContent;
  if (selection) context.selection = selection;
  if (userSelection !== undefined && userSelection !== null) {
    context.user_selection = userSelection;
  }
  if (cursorContext) context.cursor_context = cursorContext;
  if (selectionStartLine !== undefined) {
    context.selection_start_line = selectionStartLine;
  }
  if (selectionStartColumn !== undefined) {
    context.selection_start_column = selectionStartColumn;
  }
  if (selectionEndLine !== undefined) {
    context.selection_end_line = selectionEndLine;
  }
  if (selectionEndColumn !== undefined) {
    context.selection_end_column = selectionEndColumn;
  }
  if (contextBefore) context.context_before = contextBefore;
  if (contextAfter) context.context_after = contextAfter;
  if (currentSection) context.current_section = currentSection;
  if (currentEnvironment) context.current_environment = currentEnvironment;
  if (documentStructureSummary) {
    context.document_structure_summary = documentStructureSummary;
  }
  if (compileErrors !== undefined && compileErrors !== null) {
    context.compile_errors = compileErrors;
  }
  if (documentStructure) context.document_structure = documentStructure;
  if (documentIds.length > 0) context.document_ids = documentIds;
  if (webSearchSites.length > 0) context.web_search_sites = webSearchSites;
  if (useRag !== undefined) context.use_rag = useRag;

  return {
    messages,
    user_id: userId,
    space_id: scopeId,
    project_id: projectId,
    chat_id: chatId,
    page_id: pageId,
    document_ids: documentIds,
    web_search_sites: webSearchSites,
    intent_hint: dto.intent_hint || dto.intentHint || undefined,
    ...(useRag !== undefined ? { use_rag: useRag } : {}),
    // Editor / Writing Context with length safety guards
    filename,
    file_content: fileContent,
    selection,
    ...(userSelection !== undefined ? { user_selection: userSelection } : {}),
    cursor_context: cursorContext,
    cursor_line: cursorLine,
    cursor_column: cursorColumn,
    selection_start_line: selectionStartLine,
    selection_start_column: selectionStartColumn,
    selection_end_line: selectionEndLine,
    selection_end_column: selectionEndColumn,
    ...(contextBefore ? { context_before: contextBefore } : {}),
    ...(contextAfter ? { context_after: contextAfter } : {}),
    ...(currentSection ? { current_section: currentSection } : {}),
    ...(currentEnvironment ? { current_environment: currentEnvironment } : {}),
    ...(documentStructureSummary
      ? { document_structure_summary: documentStructureSummary }
      : {}),
    ...(compileErrors !== undefined ? { compile_errors: compileErrors } : {}),
    document_structure: documentStructure,
    context,
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
