import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  UnprocessableEntityException,
  NotImplementedException,
  Logger,
  Optional,
} from '@nestjs/common';
import { FastifyReply } from 'fastify';
import { EngineService } from './engine/engine.service';
import { ThreadService } from './thread/thread.service';
import { AiQueryDto } from './dto/ai.dto';
import {
  buildAiPayload,
  formatPaperContext,
  sanitizeChatTitle,
} from './utils/ai.util';

import { PrismaService } from '@/core/database/prisma.service';

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  constructor(
    private readonly engineService: EngineService,
    private readonly threadService: ThreadService,
    private readonly prisma: PrismaService,
  ) {}

  async health() {
    return this.engineService.health();
  }

  private async validateAccess(
    userId: string,
    projectId?: string,
    chatId?: string,
    pageId?: string,
  ): Promise<void> {
    if (projectId) {
      const project = await this.prisma.project.findFirst({
        where: {
          id: projectId,
          deletedAt: null,
          OR: [{ members: { some: { userId } } }, { createdById: userId }],
        },
      });
      if (!project) {
        throw new ForbiddenException('You do not have access to this project');
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

    if (pageId) {
      const page = await this.prisma.page.findFirst({
        where: { id: pageId, deletedAt: null },
        include: {
          project: {
            select: {
              createdById: true,
              members: { where: { userId }, select: { userId: true } },
            },
          },
        },
      });
      if (!page) {
        throw new NotFoundException('Document page not found');
      }
      const canAccess =
        page.authorId === userId ||
        page.project?.createdById === userId ||
        (page.project?.members && page.project.members.length > 0);
      if (!canAccess) {
        throw new ForbiddenException(
          'You do not have access to this document page',
        );
      }
    }
  }

  /**
   * Resolves storage file IDs to their underlying Vector RAG document IDs (ragDocId).
   */
  private async resolveDocumentIds(documentIds: string[]): Promise<string[]> {
    if (!documentIds || documentIds.length === 0) return [];

    const files = await this.prisma.file.findMany({
      where: { id: { in: documentIds } },
      select: { id: true, metaData: true },
    });

    const fileMap = new Map<string, string>();
    for (const f of files) {
      const meta = f.metaData as Record<string, any> | null;
      if (meta?.ragDocId) {
        fileMap.set(f.id, meta.ragDocId);
      }
    }

    return documentIds.map((id) => fileMap.get(id) || id);
  }

  /**
   * Main unified SSE streaming AI execution handler
   */
  async stream(
    userId: string,
    dto: AiQueryDto,
    reply: FastifyReply,
  ): Promise<void> {
    const targetProjectId = dto.projectId || dto.project_id;
    const targetPageId = dto.pageId || dto.page_id;
    let targetChatId = dto.chatId || dto.chat_id;

    await this.validateAccess(
      userId,
      targetProjectId,
      targetChatId,
      targetPageId,
    );

    const payload = buildAiPayload(userId, dto);
    if (payload.document_ids && payload.document_ids.length > 0) {
      payload.document_ids = await this.resolveDocumentIds(
        payload.document_ids,
      );
    }

    // Validate that user message is not empty
    const userMessages = payload.messages.filter((m) => m.role === 'user');
    const lastUserMsg = userMessages[userMessages.length - 1];
    if (!lastUserMsg || !lastUserMsg.content || !lastUserMsg.content.trim()) {
      throw new UnprocessableEntityException('Message content cannot be empty');
    }

    // Resolve or establish authoritative chat session
    let effectiveTitle = 'New Chat';
    if (targetPageId) {
      const pageSession = await this.threadService.getOrCreatePageChat(
        targetPageId,
        userId,
        targetProjectId,
      );
      targetChatId = pageSession.id;
      effectiveTitle = pageSession.title;
    } else if (!targetChatId) {
      effectiveTitle = sanitizeChatTitle(lastUserMsg.content);
      const newSession = await this.threadService.createChat(userId, {
        projectId: targetProjectId,
        title: effectiveTitle,
        documentIds: payload.document_ids,
      });
      targetChatId = newSession.id;
    }

    payload.chat_id = targetChatId;

    // Save user message to thread
    try {
      await this.threadService.appendMessages(targetChatId, userId, {
        messages: [{ role: 'user', content: lastUserMsg.content }],
        documentIds: payload.document_ids,
      });
    } catch (err) {
      this.logger.warn(`Could not persist user message to thread: ${err}`);
    }

    const initialEvents = [
      `data: [META]${JSON.stringify({
        chatId: targetChatId,
        title: effectiveTitle,
      })}\n\n`,
    ];

    const onComplete = async (accumulatedText: string) => {
      if (targetChatId && accumulatedText && accumulatedText.trim()) {
        try {
          await this.threadService.appendMessages(targetChatId, userId, {
            messages: [{ role: 'assistant', content: accumulatedText }],
            documentIds: payload.document_ids,
          });
        } catch (err) {
          this.logger.warn(
            `Could not persist assistant stream response: ${err}`,
          );
        }
      }
    };

    return this.engineService.streamChat(payload, reply, {
      initialEvents,
      onComplete,
    });
  }

  /**
   * Synchronous AI execution fallback handler
   */
  async execute(userId: string, dto: AiQueryDto) {
    const targetProjectId = dto.projectId || dto.project_id;
    const targetPageId = dto.pageId || dto.page_id;
    let targetChatId = dto.chatId || dto.chat_id;

    await this.validateAccess(
      userId,
      targetProjectId,
      targetChatId,
      targetPageId,
    );

    const payload = buildAiPayload(userId, dto);
    if (payload.document_ids && payload.document_ids.length > 0) {
      payload.document_ids = await this.resolveDocumentIds(
        payload.document_ids,
      );
    }

    // Validate that user message is not empty
    const userMessages = payload.messages.filter((m) => m.role === 'user');
    const lastUserMsg = userMessages[userMessages.length - 1];
    if (!lastUserMsg || !lastUserMsg.content || !lastUserMsg.content.trim()) {
      throw new UnprocessableEntityException('Message content cannot be empty');
    }

    // Resolve or establish authoritative chat session
    let effectiveTitle = 'New Chat';
    if (targetPageId) {
      const pageSession = await this.threadService.getOrCreatePageChat(
        targetPageId,
        userId,
        targetProjectId,
      );
      targetChatId = pageSession.id;
      effectiveTitle = pageSession.title;
    } else if (!targetChatId) {
      effectiveTitle = sanitizeChatTitle(lastUserMsg.content);
      const newSession = await this.threadService.createChat(userId, {
        projectId: targetProjectId,
        title: effectiveTitle,
        documentIds: payload.document_ids,
      });
      targetChatId = newSession.id;
    }

    payload.chat_id = targetChatId;

    // Save user message to thread
    try {
      await this.threadService.appendMessages(targetChatId, userId, {
        messages: [{ role: 'user', content: lastUserMsg.content }],
        documentIds: payload.document_ids,
      });
    } catch (err) {
      this.logger.warn(`Could not persist user message to thread: ${err}`);
    }

    const result = await this.engineService.syncChat(payload);

    if (targetChatId && result.content && result.content.trim()) {
      try {
        await this.threadService.appendMessages(targetChatId, userId, {
          messages: [
            {
              role: 'assistant',
              content: result.content,
              sources: result.sources,
              widgets: result.widgets,
            },
          ],
          documentIds: payload.document_ids,
        });
      } catch (err) {
        this.logger.warn(`Could not persist assistant sync response: ${err}`);
      }
    }

    return { ...result, chatId: targetChatId, title: effectiveTitle };
  }

  /**
   * Resolves a paper target (either a Library Item or a Storage File) and verifies access.
   */
  private async resolvePaperTarget(
    userId: string,
    paperOrFileId: string,
  ): Promise<{
    title: string;
    authors: string[];
    year?: number | string;
    doi?: string;
    abstract?: string;
    ragDocId: string | null;
    scopeId: string;
  }> {
    // 1. Try finding Library Item
    const item = await (this.prisma as any).item?.findFirst({
      where: { id: paperOrFileId, deletedAt: null },
      include: { contributors: { orderBy: { orderIndex: 'asc' } } },
    });

    if (item) {
      const hasAccess =
        item.uploadedById === userId ||
        (item.projectId
          ? (await this.prisma.projectMember.findFirst({
              where: {
                projectId: item.projectId,
                userId,
              },
            })) !== null
          : false);

      if (!hasAccess) {
        throw new ForbiddenException('You do not have access to this paper');
      }

      return {
        title: item.title,
        authors: item.contributors?.map((c: any) => c.fullName) || [],
        year: item.year || undefined,
        doi: item.doi || undefined,
        abstract: item.abstract || undefined,
        ragDocId: item.ragDocId || null,
        scopeId: item.projectId || userId,
      };
    }

    // 2. Try finding Storage File
    const file = await this.prisma.file.findFirst({
      where: { id: paperOrFileId, trashedAt: null },
      include: {
        sharedWith: { where: { userId } },
      },
    });

    if (!file) {
      throw new NotFoundException(
        `Paper or scientific file with ID ${paperOrFileId} not found`,
      );
    }

    // Access control for Storage File
    let hasAccess = file.authorId === userId || file.sharedWith.length > 0;
    if (!hasAccess && file.linkedToType === 'project' && file.linkedToId) {
      const isMember = await this.prisma.projectMember.findFirst({
        where: { projectId: file.linkedToId, userId },
      });
      hasAccess = isMember !== null;
    }

    if (!hasAccess) {
      throw new ForbiddenException('You do not have access to this file');
    }

    const meta = (file.metaData as Record<string, any>) || {};
    const scopeId =
      file.linkedToType === 'project' && file.linkedToId
        ? file.linkedToId
        : userId;

    return {
      title: meta.title || file.filename,
      authors: Array.isArray(meta.authors)
        ? meta.authors
        : meta.authors
          ? [meta.authors]
          : [],
      year: meta.year || undefined,
      doi: meta.doi || undefined,
      abstract: meta.abstract || undefined,
      ragDocId: meta.ragDocId || null,
      scopeId,
    };
  }

  /**
   * Paper-scoped streaming RAG handler (supports both Library Item and Storage File)
   */
  async streamPaper(
    userId: string,
    paperId: string,
    dto: AiQueryDto,
    reply: FastifyReply,
  ): Promise<void> {
    const resolved = await this.resolvePaperTarget(userId, paperId);

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

    const paperContext = formatPaperContext({
      title: resolved.title,
      authors: resolved.authors,
      year: resolved.year,
      doi: resolved.doi,
      abstract: resolved.abstract,
    });

    const payload = buildAiPayload(userId, dto);
    payload.workspace_id = resolved.scopeId;
    // Strict paper document scope - prevent foreign injected document IDs
    payload.document_ids = resolved.ragDocId ? [resolved.ragDocId] : [];
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
   * Paper-scoped synchronous RAG handler (supports both Library Item and Storage File)
   */
  async executePaper(userId: string, paperId: string, dto: AiQueryDto) {
    const resolved = await this.resolvePaperTarget(userId, paperId);

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

    const paperContext = formatPaperContext({
      title: resolved.title,
      authors: resolved.authors,
      year: resolved.year,
      doi: resolved.doi,
      abstract: resolved.abstract,
    });

    const payload = buildAiPayload(userId, dto);
    payload.workspace_id = resolved.scopeId;
    payload.document_ids = resolved.ragDocId ? [resolved.ragDocId] : [];
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
    fileBuffer: Buffer,
    contentType: string,
    filename: string,
    options?: {
      scopeId?: string;
      projectId?: string;
      chatId?: string;
      title?: string;
      tags?: string;
    },
  ) {
    const scopeId = options?.scopeId || options?.projectId || userId;
    await this.validateAccess(userId, options?.projectId, options?.chatId);
    return this.engineService.uploadDocument(
      fileBuffer,
      contentType,
      filename,
      {
        userId,
        scopeId,
        projectId: options?.projectId,
        chatId: options?.chatId,
        title: options?.title,
        tags: options?.tags,
      },
    );
  }

  async getDocumentsBulk(userId: string, ids: string[], projectId?: string) {
    await this.validateAccess(userId, projectId);
    const scopeId = projectId || userId;
    return this.engineService.getDocumentsBulk(ids, {
      userId,
      scopeId,
      projectId,
    });
  }

  async getDocument(userId: string, docId: string, projectId?: string) {
    await this.validateAccess(userId, projectId);
    const scopeId = projectId || userId;
    return this.engineService.getDocument(docId, {
      userId,
      scopeId,
      projectId,
    });
  }

  async getDocuments(userId: string, projectId?: string) {
    await this.validateAccess(userId, projectId);
    const scopeId = projectId || userId;
    return this.engineService.getDocuments({ userId, scopeId, projectId });
  }
}
