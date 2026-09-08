import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  NotImplementedException,
  Logger,
  Optional,
} from '@nestjs/common';
import { FastifyReply } from 'fastify';
import { EngineService } from './engine/engine.service';
import { ThreadService } from './thread/thread.service';
import { AiQueryDto } from './dto/ai.dto';
import { CatalogService } from '../library/items/items.service';
import { buildAiPayload, formatPaperContext } from './utils/ai.util';

import { PrismaService } from '@/core/database/prisma.service';

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  constructor(
    private readonly engineService: EngineService,
    private readonly threadService: ThreadService,
    private readonly prisma: PrismaService,
    @Optional() private readonly catalogService?: CatalogService,
  ) {}

  async health() {
    return this.engineService.health();
  }

  private async validateAccess(
    userId: string,
    workspaceId?: string,
    projectId?: string,
    chatId?: string,
  ): Promise<void> {
    if (workspaceId) {
      const member = await this.prisma.workspaceMember.findFirst({
        where: { workspaceId, userId },
      });
      if (!member) {
        throw new ForbiddenException(
          'You do not have access to this workspace',
        );
      }
    }

    if (projectId) {
      const project = await this.prisma.project.findFirst({
        where: {
          id: projectId,
          workspace: {
            members: {
              some: { userId },
            },
          },
        },
      });
      if (!project) {
        throw new ForbiddenException(
          'You do not have access to this project or its workspace',
        );
      }
      if (workspaceId && project.workspaceId !== workspaceId) {
        throw new BadRequestException(
          'Project does not belong to the specified workspace',
        );
      }
    }

    if (chatId) {
      const chat = await this.prisma.aiChat.findFirst({
        where: { id: chatId },
      });
      if (chat && chat.userId !== userId) {
        throw new ForbiddenException(
          'You do not have access to this chat session',
        );
      }
    }
  }

  /**
   * Main unified SSE streaming AI execution handler
   */
  async stream(
    userId: string,
    dto: AiQueryDto,
    reply: FastifyReply,
  ): Promise<void> {
    const targetWsId = dto.workspaceId || dto.workspace_id;
    const targetProjectId = dto.projectId || dto.project_id;
    const targetChatId = dto.chatId || dto.chat_id;

    await this.validateAccess(
      userId,
      targetWsId,
      targetProjectId,
      targetChatId,
    );

    const payload = buildAiPayload(userId, dto);

    // Save user message to thread if chatId is provided
    if (payload.chat_id && payload.messages.length > 0) {
      const lastMsg = payload.messages[payload.messages.length - 1];
      if (lastMsg.role === 'user' && lastMsg.content.trim()) {
        try {
          await this.threadService.appendMessages(payload.chat_id, userId, {
            messages: [{ role: 'user', content: lastMsg.content }],
          });
        } catch (err) {
          this.logger.warn(
            `Could not persist user message to thread: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    return this.engineService.streamChat(payload, reply);
  }

  /**
   * Synchronous AI execution fallback handler
   */
  async execute(userId: string, dto: AiQueryDto) {
    const targetWsId = dto.workspaceId || dto.workspace_id;
    const targetProjectId = dto.projectId || dto.project_id;
    const targetChatId = dto.chatId || dto.chat_id;

    await this.validateAccess(
      userId,
      targetWsId,
      targetProjectId,
      targetChatId,
    );

    const payload = buildAiPayload(userId, dto);
    return this.engineService.syncChat(payload);
  }

  /**
   * Paper-scoped streaming RAG handler
   */
  async streamPaper(
    userId: string,
    paperId: string,
    dto: AiQueryDto,
    reply: FastifyReply,
  ): Promise<void> {
    const paper = await this.prisma.catalogItem.findFirst({
      where: { id: paperId, deletedAt: null },
      include: { contributors: { orderBy: { orderIndex: 'asc' } } },
    });

    if (!paper) {
      throw new NotFoundException(`Paper with ID ${paperId} not found`);
    }

    // Verify workspace membership for the paper
    const member = await this.prisma.workspaceMember.findFirst({
      where: { workspaceId: paper.workspaceId, userId },
    });
    if (!member) {
      throw new ForbiddenException('You do not have access to this paper');
    }

    // Disallow overriding paper workspace
    if (dto.workspaceId && dto.workspaceId !== paper.workspaceId) {
      throw new BadRequestException(
        'Workspace ID mismatch with paper workspace',
      );
    }
    if (dto.workspace_id && dto.workspace_id !== paper.workspaceId) {
      throw new BadRequestException(
        'Workspace ID mismatch with paper workspace',
      );
    }
    const workspaceId = paper.workspaceId;

    // Chat ID ownership verification if provided, or secure user-scoped default
    let chatId = dto.chatId || dto.chat_id;
    if (chatId) {
      const existingChat = await this.prisma.aiChat.findFirst({
        where: { id: chatId },
      });
      if (existingChat && existingChat.userId !== userId) {
        throw new ForbiddenException(
          'You do not have access to this chat session',
        );
      }
    } else {
      chatId = `paper-${paperId}-${userId}`;
    }

    const paperDocId = paper.ragDocId || null;
    const paperContext = formatPaperContext({
      title: paper.title,
      authors: paper.contributors?.map((c) => c.fullName) || [],
      year: paper.year || undefined,
      doi: paper.doi || undefined,
      abstract: paper.abstract || undefined,
    });

    const payload = buildAiPayload(userId, dto);
    payload.workspace_id = workspaceId;
    // Strict paper document scope - prevent foreign injected document IDs
    payload.document_ids = paperDocId ? [paperDocId] : [];
    payload.chat_id = chatId;
    payload.intent_hint = 'paper_rag_qa';

    if (paperContext) {
      payload.messages = [
        { role: 'system' as const, content: paperContext },
        ...payload.messages,
      ];
    }

    return this.engineService.streamChat(payload, reply);
  }

  /**
   * Paper-scoped synchronous RAG handler
   */
  async executePaper(userId: string, paperId: string, dto: AiQueryDto) {
    const paper = await this.prisma.catalogItem.findFirst({
      where: { id: paperId, deletedAt: null },
      include: { contributors: { orderBy: { orderIndex: 'asc' } } },
    });

    if (!paper) {
      throw new NotFoundException(`Paper with ID ${paperId} not found`);
    }

    // Verify workspace membership for the paper
    const member = await this.prisma.workspaceMember.findFirst({
      where: { workspaceId: paper.workspaceId, userId },
    });
    if (!member) {
      throw new ForbiddenException('You do not have access to this paper');
    }

    // Disallow overriding paper workspace
    if (dto.workspaceId && dto.workspaceId !== paper.workspaceId) {
      throw new BadRequestException(
        'Workspace ID mismatch with paper workspace',
      );
    }
    if (dto.workspace_id && dto.workspace_id !== paper.workspaceId) {
      throw new BadRequestException(
        'Workspace ID mismatch with paper workspace',
      );
    }
    const workspaceId = paper.workspaceId;

    // Chat ID ownership verification if provided, or secure user-scoped default
    let chatId = dto.chatId || dto.chat_id;
    if (chatId) {
      const existingChat = await this.prisma.aiChat.findFirst({
        where: { id: chatId },
      });
      if (existingChat && existingChat.userId !== userId) {
        throw new ForbiddenException(
          'You do not have access to this chat session',
        );
      }
    } else {
      chatId = `paper-${paperId}-${userId}`;
    }

    const paperDocId = paper.ragDocId || null;
    const paperContext = formatPaperContext({
      title: paper.title,
      authors: paper.contributors?.map((c) => c.fullName) || [],
      year: paper.year || undefined,
      doi: paper.doi || undefined,
      abstract: paper.abstract || undefined,
    });

    const payload = buildAiPayload(userId, dto);
    payload.workspace_id = workspaceId;
    payload.document_ids = paperDocId ? [paperDocId] : [];
    payload.chat_id = chatId;
    payload.intent_hint = 'paper_rag_qa';

    if (paperContext) {
      payload.messages = [
        { role: 'system' as const, content: paperContext },
        ...payload.messages,
      ];
    }

    return this.engineService.syncChat(payload);
  }

  // ── Document Vector Management with Strict Multi-Tenant Isolation ──
  async uploadDocument(
    userId: string,
    workspaceId: string,
    fileBuffer: Buffer,
    contentType: string,
    filename: string,
    options?: {
      projectId?: string;
      chatId?: string;
      title?: string;
      tags?: string;
    },
  ) {
    if (!workspaceId) {
      throw new BadRequestException('workspaceId is required');
    }
    await this.validateAccess(
      userId,
      workspaceId,
      options?.projectId,
      options?.chatId,
    );
    return this.engineService.uploadDocument(
      fileBuffer,
      contentType,
      filename,
      {
        userId,
        workspaceId,
        projectId: options?.projectId,
        chatId: options?.chatId,
        title: options?.title,
        tags: options?.tags,
      },
    );
  }

  async getDocumentsBulk(userId: string, workspaceId: string, ids: string[]) {
    if (!workspaceId) {
      throw new BadRequestException('workspaceId is required');
    }
    await this.validateAccess(userId, workspaceId);
    return this.engineService.getDocumentsBulk(ids, { userId, workspaceId });
  }

  async getDocument(userId: string, workspaceId: string, docId: string) {
    if (!workspaceId) {
      throw new BadRequestException('workspaceId is required');
    }
    await this.validateAccess(userId, workspaceId);
    return this.engineService.getDocument(docId, { userId, workspaceId });
  }

  async getDocuments(userId: string, workspaceId: string) {
    if (!workspaceId) {
      throw new BadRequestException('workspaceId is required');
    }
    await this.validateAccess(userId, workspaceId);
    return this.engineService.getDocuments({ userId, workspaceId });
  }
}
