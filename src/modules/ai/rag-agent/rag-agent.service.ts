import { Injectable, NotFoundException } from '@nestjs/common';
import { FastifyReply } from 'fastify';
import { EngineService } from '../engine/engine.service';
import { RagAgentQueryDto } from './dto/rag-agent.dto';

import { CatalogRepository } from '../../library/catalog/catalog.repository';

@Injectable()
export class RagAgentService {
  constructor(
    private readonly engineService: EngineService,
    private readonly catalogRepo: CatalogRepository,
  ) {}

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
    const list =
      dto.document_ids || dto.documentIds || dto.selected_files || [];
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

  /**
   * Paper-Scoped Streaming RAG Chat: Contextualizes conversation with the specific paper
   */
  async streamPaperChat(
    userId: string,
    paperId: string,
    dto: RagAgentQueryDto,
    reply: FastifyReply,
  ): Promise<void> {
    const paper = await this.catalogRepo.findItemById(paperId);
    if (!paper || paper.deletedAt) {
      throw new NotFoundException(`Paper with ID ${paperId} not found`);
    }

    const messages = this.normalizeMessages(dto);
    const documentIds = paper.ragDocId
      ? [paper.ragDocId]
      : this.extractDocIds(dto);
    const workspaceId =
      dto.workspace_id || dto.workspaceId || paper.workspaceId;
    const chatId = dto.chat_id || dto.chatId || `paper-${paperId}`;

    // Prepend system context with paper groundings
    const authorsStr = Array.isArray(paper.authors)
      ? paper.authors.join(', ')
      : '';
    const paperContext = `Paper Context: Title: "${paper.title}", Authors: "${authorsStr}", Year: ${paper.year || 'N/A'}, DOI: ${paper.doi || 'N/A'}.\nAbstract: ${paper.abstract || 'N/A'}`;

    const enrichedMessages = [
      { role: 'system' as const, content: paperContext },
      ...messages,
    ];

    const payload = {
      messages: enrichedMessages,
      user_id: userId,
      workspace_id: workspaceId,
      chat_id: chatId,
      document_ids: documentIds,
      intent_hint: 'paper_rag_qa',
    };

    return this.engineService.streamChat(payload, reply);
  }

  /**
   * Paper-Scoped Synchronous RAG Chat
   */
  async syncPaperChat(userId: string, paperId: string, dto: RagAgentQueryDto) {
    const paper = await this.catalogRepo.findItemById(paperId);
    if (!paper || paper.deletedAt) {
      throw new NotFoundException(`Paper with ID ${paperId} not found`);
    }

    const messages = this.normalizeMessages(dto);
    const documentIds = paper.ragDocId
      ? [paper.ragDocId]
      : this.extractDocIds(dto);
    const workspaceId =
      dto.workspace_id || dto.workspaceId || paper.workspaceId;
    const chatId = dto.chat_id || dto.chatId || `paper-${paperId}`;

    const authorsStr = Array.isArray(paper.authors)
      ? paper.authors.join(', ')
      : '';
    const paperContext = `Paper Context: Title: "${paper.title}", Authors: "${authorsStr}", Year: ${paper.year || 'N/A'}, DOI: ${paper.doi || 'N/A'}.\nAbstract: ${paper.abstract || 'N/A'}`;

    const enrichedMessages = [
      { role: 'system' as const, content: paperContext },
      ...messages,
    ];

    const payload = {
      messages: enrichedMessages,
      user_id: userId,
      workspace_id: workspaceId,
      chat_id: chatId,
      document_ids: documentIds,
      intent_hint: 'paper_rag_qa',
    };

    return this.engineService.syncChat(payload);
  }
}
