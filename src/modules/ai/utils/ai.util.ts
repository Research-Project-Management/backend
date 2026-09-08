import { AiQueryDto } from '../dto/ai.dto';
import { AiEnginePayload } from '../types/ai.types';
import { AiMessageDto } from '../engine/types/engine.types';

/**
 * Normalizes input messages from DTO, handling both `messages` array and fallback `query` string.
 */
export function normalizeMessages(dto: AiQueryDto): AiMessageDto[] {
  if (Array.isArray(dto.messages) && dto.messages.length > 0) {
    return dto.messages.map((m) => ({
      role: m.role,
      content: m.content || '',
    }));
  }
  if (dto.query && dto.query.trim()) {
    return [{ role: 'user', content: dto.query.trim() }];
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
  const workspaceId =
    dto.workspace_id ||
    dto.workspaceId ||
    dto.project_id ||
    dto.projectId ||
    '';
  const projectId = dto.project_id || dto.projectId || '';
  const chatId = dto.chat_id || dto.chatId || '';

  return {
    messages,
    user_id: userId,
    workspace_id: workspaceId,
    project_id: projectId,
    chat_id: chatId,
    document_ids: documentIds,
    web_search_sites: dto.web_search_sites || dto.webSearchSites || [],
    intent_hint: dto.intent_hint || dto.intentHint || undefined,
    // Editor / Writing Context
    filename: dto.filename || 'document.tex',
    file_content: dto.file_content || dto.fileContent || '',
    selection: dto.selection || '',
    cursor_context: dto.cursor_context || dto.cursorContext || '',
    cursor_line: dto.cursor_line ?? dto.cursorLine ?? 1,
    cursor_column: dto.cursor_column ?? dto.cursorColumn ?? 1,
    selection_start_line: dto.selection_start_line ?? dto.selectionStartLine,
    selection_start_column:
      dto.selection_start_column ?? dto.selectionStartColumn,
    selection_end_line: dto.selection_end_line ?? dto.selectionEndLine,
    selection_end_column: dto.selection_end_column ?? dto.selectionEndColumn,
    document_structure: dto.document_structure || dto.documentStructure || '',
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
