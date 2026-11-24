import type {
  EngineChatRequest,
  EngineMessage,
} from '../../engine/types/engine.type';
import { AI_CONTEXT_CHAR_LIMITS } from '../../ai.constant';
import type { LlmOverridePayload } from '../../access/types/access.type';
import type { QueryDto } from '../dto/query.dto';
import { sanitizeMessageContent, sanitizeMessageRole } from './session.mapper';

export interface NormalizedUserMessage {
  role: 'user' | 'assistant';
  content: string;
  attachments?: unknown;
  sources?: unknown;
}

export function extractNormalizedMessages(
  dto: QueryDto,
): NormalizedUserMessage[] {
  if (Array.isArray(dto.messages) && dto.messages.length > 0) {
    return dto.messages.map((m) => ({
      role: sanitizeMessageRole(m.role),
      content: sanitizeMessageContent(m.content),
      ...(m.attachments !== undefined ? { attachments: m.attachments } : {}),
      ...(m.sources !== undefined ? { sources: m.sources } : {}),
    }));
  }
  if (dto.query && dto.query.trim()) {
    return [
      {
        role: 'user',
        content: sanitizeMessageContent(dto.query),
      },
    ];
  }
  return [{ role: 'user', content: '' }];
}

export function normalizeIntentHint(
  rawHint: string | undefined,
  hasDocuments: boolean,
  hasAllowedDomains: boolean,
): string | null {
  const hint = (rawHint || '').trim().toLowerCase();
  if (!hint) return null;
  if (hint === 'rag' || hint === 'paper_rag_qa' || hint === 'rag_agent') {
    return 'rag_agent';
  }
  if (hint === 'web_search' || hint === 'web_search_agent') {
    return 'web_search_agent';
  }
  if (hint === 'library' || hint === 'library_agent') {
    return 'library_agent';
  }
  if (hint === 'editor' || hint === 'editor_agent' || hint === 'latex_editor') {
    return 'editor_agent';
  }
  if (hint === 'project_agent') {
    return 'project_agent';
  }
  if (
    hint === 'project' ||
    hint === 'work_item' ||
    hint === 'work_item_agent' ||
    hint === 'workspace_agent'
  ) {
    return !hasDocuments && !hasAllowedDomains ? 'project_agent' : null;
  }
  if (hint === 'latex') {
    return !hasDocuments && !hasAllowedDomains ? 'editor_agent' : null;
  }
  if (hint === 'direct' || hint === 'chat') {
    return !hasDocuments && !hasAllowedDomains ? 'direct' : null;
  }
  return null;
}

export function buildEngineChatRequest(params: {
  userId: string;
  spaceId: string;
  projectId?: string | null;
  chatId?: string | null;
  pageId?: string | null;
  documentIds?: string[];
  dto: QueryDto;
  prependSystemMessage?: string;
  delegationToken?: string;
  llmOverride?: LlmOverridePayload | null;
}): EngineChatRequest {
  const { dto } = params;
  const normalizedMsgs = extractNormalizedMessages(dto);
  const engineMessages: EngineMessage[] = normalizedMsgs.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  if (params.prependSystemMessage) {
    engineMessages.unshift({
      role: 'system',
      content: params.prependSystemMessage,
    });
  }

  const documentIds = params.documentIds ?? dto.documentIds ?? [];
  const pageId = params.pageId ?? dto.pageId ?? null;
  const webSearchSites = dto.webSearchSites ?? [];
  const rawContext =
    dto.context && typeof dto.context === 'object' ? { ...dto.context } : {};

  const rawDocStructure = dto.documentStructure;
  const documentStructure = (
    typeof rawDocStructure === 'string'
      ? rawDocStructure
      : Array.isArray(rawDocStructure) ||
          (rawDocStructure && typeof rawDocStructure === 'object')
        ? JSON.stringify(rawDocStructure)
        : ''
  ).slice(0, AI_CONTEXT_CHAR_LIMITS.DOCUMENT_STRUCTURE);

  const fileContent = (dto.fileContent || '').slice(
    0,
    AI_CONTEXT_CHAR_LIMITS.FILE_CONTENT,
  );
  const selection = (dto.selection || '').slice(
    0,
    AI_CONTEXT_CHAR_LIMITS.SELECTION,
  );
  const cursorContext = (dto.cursorContext || '').slice(
    0,
    AI_CONTEXT_CHAR_LIMITS.CURSOR_CONTEXT,
  );
  const contextBefore = (dto.contextBefore || '').slice(
    0,
    AI_CONTEXT_CHAR_LIMITS.CONTEXT_BEFORE,
  );
  const contextAfter = (dto.contextAfter || '').slice(
    0,
    AI_CONTEXT_CHAR_LIMITS.CONTEXT_AFTER,
  );
  const currentSection = (dto.currentSection || '').slice(
    0,
    AI_CONTEXT_CHAR_LIMITS.CURRENT_SECTION,
  );
  const currentEnvironment = (dto.currentEnvironment || '').slice(
    0,
    AI_CONTEXT_CHAR_LIMITS.CURRENT_ENVIRONMENT,
  );
  const documentStructureSummary = (dto.documentStructureSummary || '').slice(
    0,
    AI_CONTEXT_CHAR_LIMITS.DOCUMENT_STRUCTURE_SUMMARY,
  );

  const context: Record<string, unknown> = {
    ...rawContext,
    user_id: params.userId,
  };
  if (pageId) context.page_id = pageId;
  if (params.projectId) context.project_id = params.projectId;
  if (documentIds.length > 0) context.document_ids = documentIds;
  if (webSearchSites.length > 0 && !context.allowed_domains) {
    context.allowed_domains = webSearchSites;
  }
  if (dto.filename) context.filename = dto.filename;
  if (dto.activeFileId) context.active_file_id = dto.activeFileId;
  if (dto.activeFilePath) context.active_file_path = dto.activeFilePath;
  if (dto.cursorLine !== undefined) context.cursor_line = dto.cursorLine;
  if (dto.cursorColumn !== undefined) context.cursor_column = dto.cursorColumn;
  if (fileContent) context.file_content = fileContent;
  if (selection) context.selection = selection;
  if (dto.userSelection !== undefined && dto.userSelection !== null) {
    context.user_selection = dto.userSelection;
  }
  if (cursorContext) context.cursor_context = cursorContext;
  if (dto.selectionStartLine !== undefined) {
    context.selection_start_line = dto.selectionStartLine;
  }
  if (dto.selectionStartColumn !== undefined) {
    context.selection_start_column = dto.selectionStartColumn;
  }
  if (dto.selectionEndLine !== undefined) {
    context.selection_end_line = dto.selectionEndLine;
  }
  if (dto.selectionEndColumn !== undefined) {
    context.selection_end_column = dto.selectionEndColumn;
  }
  if (contextBefore) context.context_before = contextBefore;
  if (contextAfter) context.context_after = contextAfter;
  if (currentSection) context.current_section = currentSection;
  if (currentEnvironment) context.current_environment = currentEnvironment;
  if (documentStructureSummary) {
    context.document_structure_summary = documentStructureSummary;
  }
  if (dto.compileErrors !== undefined && dto.compileErrors !== null) {
    context.compile_errors = dto.compileErrors;
  }
  if (documentStructure) context.document_structure = documentStructure;
  if (dto.useRag !== undefined) context.use_rag = dto.useRag;
  if (params.llmOverride?.api_key) {
    context.llm_override = params.llmOverride;
  }

  const allowedDomains = Array.isArray(context.allowed_domains)
    ? context.allowed_domains
    : [];
  const resolvedIntent = normalizeIntentHint(
    dto.intentHint,
    documentIds.length > 0,
    allowedDomains.length > 0,
  );

  return {
    messages: engineMessages,
    space_id: params.spaceId,
    chat_id: params.chatId || null,
    stateless: !params.chatId,
    page_id: pageId,
    document_ids: documentIds,
    intent_hint: resolvedIntent,
    context,
    ...(params.delegationToken
      ? { delegation_token: params.delegationToken }
      : {}),
  };
}

export function formatPaperGroundingPrompt(paper: {
  title?: string;
  authors?: string[] | string;
  year?: number | string;
  doi?: string;
  arxivId?: string;
  venue?: string;
  pageCount?: number;
  citationCount?: number;
  abstract?: string;
}): string {
  const authorsStr = Array.isArray(paper.authors)
    ? paper.authors.join(', ')
    : paper.authors || '';
  const fields: string[] = [
    `Title: "${paper.title || 'Untitled'}"`,
    `Authors: "${authorsStr}"`,
    `Year: ${paper.year || 'N/A'}`,
    `DOI: ${paper.doi || 'N/A'}`,
  ];
  if (paper.arxivId) fields.push(`arXiv: ${paper.arxivId}`);
  if (paper.venue) fields.push(`Venue: "${paper.venue}"`);
  if (typeof paper.pageCount === 'number' && paper.pageCount > 0) {
    fields.push(`Total Pages: ${paper.pageCount}`);
  }
  if (typeof paper.citationCount === 'number' && paper.citationCount >= 0) {
    fields.push(`Recorded Citation Count: ${paper.citationCount}`);
  }
  return `Paper Context: ${fields.join(', ')}.\nAbstract: ${paper.abstract || 'N/A'}`;
}
