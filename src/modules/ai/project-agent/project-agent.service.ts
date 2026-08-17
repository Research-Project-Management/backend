import { Injectable } from '@nestjs/common';
import { FastifyReply } from 'fastify';
import { EngineService } from '../engine/engine.service';
import { ThreadService } from '../thread/thread.service';
import { ProjectAgentQueryDto } from './dto/project-agent.dto';

@Injectable()
export class ProjectAgentService {
  constructor(
    private readonly engineService: EngineService,
    private readonly threadService: ThreadService,
  ) {}

  private normalizeMessages(dto: ProjectAgentQueryDto) {
    if (Array.isArray(dto.messages) && dto.messages.length > 0) {
      return dto.messages.map((m) => ({
        role: m.role,
        content: m.content || '',
      }));
    }
    if (dto.query && dto.query.trim()) {
      return [{ role: 'user' as const, content: dto.query.trim() }];
    }
    return [];
  }

  async streamProjectChat(
    userId: string,
    dto: ProjectAgentQueryDto,
    reply: FastifyReply,
  ): Promise<void> {
    const messages = this.normalizeMessages(dto);
    const workspaceId = dto.workspace_id || dto.workspaceId || null;
    const projectId = dto.project_id || dto.projectId || null;
    const chatId = dto.chat_id || dto.chatId || null;

    const payload = {
      messages,
      user_id: userId,
      workspace_id: workspaceId,
      project_id: projectId,
      chat_id: chatId,
      intent_hint: dto.intent_hint || 'project_workspace_agent',
      web_search_sites: dto.web_search_sites || null,
      document_ids: dto.document_ids || null,
      selection: dto.selection || null,
      cursor_context: dto.cursor_context || null,
    };

    return this.engineService.streamChat(payload, reply);
  }

  async syncProjectChat(userId: string, dto: ProjectAgentQueryDto) {
    const messages = this.normalizeMessages(dto);
    const workspaceId = dto.workspace_id || dto.workspaceId || null;
    const projectId = dto.project_id || dto.projectId || null;
    const chatId = dto.chat_id || dto.chatId || null;

    const payload = {
      messages,
      user_id: userId,
      workspace_id: workspaceId,
      project_id: projectId,
      chat_id: chatId,
      intent_hint: dto.intent_hint || 'project_workspace_agent',
      web_search_sites: dto.web_search_sites || null,
      document_ids: dto.document_ids || null,
    };

    return this.engineService.syncChat(payload);
  }
}
