import { Injectable } from '@nestjs/common';
import { FastifyReply } from 'fastify';
import { EngineService } from '../engine/engine.service';
import { RagAgentQueryDto } from './dto/rag-agent.dto';

@Injectable()
export class RagAgentService {
  constructor(private readonly engineService: EngineService) {}

  private normalizeMessages(dto: RagAgentQueryDto) {
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

  private extractDocIds(dto: RagAgentQueryDto): string[] | null {
    const list = dto.document_ids || dto.documentIds || dto.selected_files || [];
    return list.length > 0 ? list : null;
  }

  async streamRagChat(
    userId: string,
    dto: RagAgentQueryDto,
    reply: FastifyReply,
  ): Promise<void> {
    const messages = this.normalizeMessages(dto);
    const documentIds = this.extractDocIds(dto);
    const workspaceId = dto.workspace_id || dto.workspaceId || null;
    const chatId = dto.chat_id || dto.chatId || null;

    const payload = {
      messages,
      user_id: userId,
      workspace_id: workspaceId,
      chat_id: chatId,
      document_ids: documentIds,
      intent_hint: dto.intent_hint || 'paper_rag_qa',
    };

    return this.engineService.streamChat(payload, reply);
  }

  async syncRagChat(userId: string, dto: RagAgentQueryDto) {
    const messages = this.normalizeMessages(dto);
    const documentIds = this.extractDocIds(dto);
    const workspaceId = dto.workspace_id || dto.workspaceId || null;
    const chatId = dto.chat_id || dto.chatId || null;

    const payload = {
      messages,
      user_id: userId,
      workspace_id: workspaceId,
      chat_id: chatId,
      document_ids: documentIds,
      intent_hint: dto.intent_hint || 'paper_rag_qa',
    };

    return this.engineService.syncChat(payload);
  }

  async uploadDocument(rawBuffer: Buffer, contentType: string) {
    return this.engineService.uploadDocument(rawBuffer, contentType);
  }

  async getDocumentsBulk(ids: string[]) {
    return this.engineService.getDocumentsBulk(ids);
  }

  async getDocument(docId: string) {
    return this.engineService.getDocument(docId);
  }

  async getDocuments() {
    return this.engineService.getDocuments();
  }
}
