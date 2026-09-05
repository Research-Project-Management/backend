import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { FastifyReply } from 'fastify';
import { EngineService } from '../engine/engine.service';
import { RagAgentQueryDto } from './dto/rag-agent.dto';

import { CatalogService } from '../../library/items/items.service';

@Injectable()
export class RagAgentService {
  constructor(
    private readonly engineService: EngineService,
    private readonly catalogService: CatalogService,
  ) {}

  private normalizeMessages(dto: RagAgentQueryDto) {
    if (Array.isArray(dto.messages) && dto.messages.length > 0) {
      return dto.messages.map((m) => ({
        role: m.role,
        content: m.content || '',
      }));
    }
    if (dto.query) {
      return [{ role: 'user' as const, content: dto.query }];
    }
    return [{ role: 'user' as const, content: '' }];
  }

  private extractDocIds(dto: RagAgentQueryDto): string[] {
    return dto.document_ids || dto.documentIds || dto.selected_files || [];
  }

  async streamRagChat(
    userId: string,
    dto: RagAgentQueryDto,
    reply: FastifyReply,
  ): Promise<void> {
    const messages = this.normalizeMessages(dto);
    const documentIds = this.extractDocIds(dto);
    const workspaceId =
      dto.workspace_id || dto.workspaceId || dto.project_id || dto.projectId;
    const chatId = dto.chat_id || dto.chatId;

    const payload = {
      messages,
      user_id: userId,
      workspace_id: workspaceId,
      chat_id: chatId,
      document_ids: documentIds,
      intent_hint: dto.intent_hint,
    };

    return this.engineService.streamChat(payload, reply);
  }

  async syncRagChat(userId: string, dto: RagAgentQueryDto) {
    const messages = this.normalizeMessages(dto);
    const documentIds = this.extractDocIds(dto);
    const workspaceId =
      dto.workspace_id || dto.workspaceId || dto.project_id || dto.projectId;
    const chatId = dto.chat_id || dto.chatId;

    const payload = {
      messages,
      user_id: userId,
      workspace_id: workspaceId,
      chat_id: chatId,
      document_ids: documentIds,
      intent_hint: dto.intent_hint,
    };

    return this.engineService.syncChat(payload);
  }

  async uploadDocument(fileBuffer: Buffer, contentType: string) {
    return this.engineService.uploadDocument(fileBuffer, contentType);
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
   * Paper-Scoped Streaming RAG Chat: Contextualizes conversation with the specific paper within authorized workspace.
   */
  async streamPaperChat(
    userId: string,
    paperId: string,
    dto: RagAgentQueryDto,
    reply: FastifyReply,
  ): Promise<void> {
    const workspaceId = dto.workspaceId || dto.workspace_id;
    if (!workspaceId) {
      throw new BadRequestException(
        'workspaceId is required for paper-scoped chat',
      );
    }

    const paper = await this.catalogService.getItem(
      workspaceId,
      paperId,
      userId,
    );
    if (!paper || paper.deletedAt) {
      throw new NotFoundException(`Paper with ID ${paperId} not found`);
    }

    const messages = this.normalizeMessages(dto);
    const documentIds = paper.ragDocId
      ? [paper.ragDocId]
      : this.extractDocIds(dto);
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
   * Paper-Scoped Synchronous RAG Chat within authorized workspace.
   */
  async syncPaperChat(userId: string, paperId: string, dto: RagAgentQueryDto) {
    const workspaceId = dto.workspaceId || dto.workspace_id;
    if (!workspaceId) {
      throw new BadRequestException(
        'workspaceId is required for paper-scoped chat',
      );
    }

    const paper = await this.catalogService.getItem(
      workspaceId,
      paperId,
      userId,
    );
    if (!paper || paper.deletedAt) {
      throw new NotFoundException(`Paper with ID ${paperId} not found`);
    }

    const messages = this.normalizeMessages(dto);
    const documentIds = paper.ragDocId
      ? [paper.ragDocId]
      : this.extractDocIds(dto);
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
