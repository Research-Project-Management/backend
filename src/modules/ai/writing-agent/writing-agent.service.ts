import { Injectable } from '@nestjs/common';
import { FastifyReply } from 'fastify';
import { EngineService } from '../engine/engine.service';
import { WritingAgentQueryDto } from './dto/writing-agent.dto';

@Injectable()
export class WritingAgentService {
  constructor(private readonly engineService: EngineService) {}

  private normalizeMessages(dto: WritingAgentQueryDto) {
    if (Array.isArray(dto.messages) && dto.messages.length > 0) {
      return dto.messages.map((m) => ({
        role: m.role,
        content: m.content || '',
      }));
    }
    return [];
  }

  async streamWritingChat(
    userId: string,
    dto: WritingAgentQueryDto,
    reply: FastifyReply,
  ): Promise<void> {
    const messages = this.normalizeMessages(dto);
    const workspaceId = dto.workspace_id || dto.workspaceId || null;
    const projectId = dto.project_id || dto.projectId || null;
    const chatId = dto.chat_id || dto.chatId || null;
    const pageId = dto.page_id || dto.pageId || null;
    const filename = dto.filename || 'main.tex';
    const fileContent = dto.file_content || dto.fileContent || null;

    const payload = {
      messages,
      user_id: userId,
      workspace_id: workspaceId,
      project_id: projectId,
      chat_id: chatId,
      page_id: pageId,
      filename,
      file_content: fileContent,
      selection: dto.selection || null,
      cursor_context: dto.cursor_context || dto.cursorContext || null,
      selection_start_line:
        dto.selection_start_line ?? dto.selectionStartLine ?? null,
      selection_end_line:
        dto.selection_end_line ?? dto.selectionEndLine ?? null,
      selection_start_column:
        dto.selection_start_column ?? dto.selectionStartColumn ?? null,
      selection_end_column:
        dto.selection_end_column ?? dto.selectionEndColumn ?? null,
      context_before: dto.context_before || dto.contextBefore || null,
      context_after: dto.context_after || dto.contextAfter || null,
      current_section: dto.current_section || dto.currentSection || null,
      current_environment:
        dto.current_environment || dto.currentEnvironment || null,
      document_structure_summary:
        dto.document_structure_summary || dto.documentStructureSummary || null,
      compile_errors: dto.compile_errors || null,
      intent_hint: 'latex_writing_assistant',
    };

    return this.engineService.streamChat(payload, reply);
  }

  async syncWritingChat(userId: string, dto: WritingAgentQueryDto) {
    const messages = this.normalizeMessages(dto);
    const workspaceId = dto.workspace_id || dto.workspaceId || null;
    const projectId = dto.project_id || dto.projectId || null;
    const chatId = dto.chat_id || dto.chatId || null;
    const filename = dto.filename || 'main.tex';
    const fileContent = dto.file_content || dto.fileContent || null;

    const payload = {
      messages,
      user_id: userId,
      workspace_id: workspaceId,
      project_id: projectId,
      chat_id: chatId,
      filename,
      file_content: fileContent,
      selection: dto.selection || null,
      cursor_context: dto.cursor_context || dto.cursorContext || null,
      intent_hint: 'latex_writing_assistant',
    };

    return this.engineService.syncChat(payload);
  }
}
