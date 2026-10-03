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
import { ChatService } from './chat/chat.service';
import { AiQueryDto } from './dto/ai.dto';
import {
  buildAiPayload,
  formatPaperContext,
  sanitizeChatTitle,
} from './utils/ai.util';

import * as crypto from 'node:crypto';
import { PrismaService } from '@/core/database/prisma.service';
import { RedisCacheService } from '@/core/cache/redis.service';

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  constructor(
    private readonly engineService: EngineService,
    private readonly chatService: ChatService,
    private readonly prisma: PrismaService,
    @Optional() private readonly redis?: RedisCacheService,
  ) {}

  async health() {
    return this.engineService.health();
  }

  private isValidUuid(id?: string | null): boolean {
    if (!id) return false;
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      id.trim(),
    );
  }

  private sanitizeProjectId(projectId?: string | null): string | undefined {
    if (!projectId) return undefined;
    const trimmed = projectId.trim();
    if (
      trimmed === 'me' ||
      trimmed === 'user' ||
      trimmed === 'all' ||
      trimmed === 'null' ||
      trimmed === 'undefined' ||
      !this.isValidUuid(trimmed)
    ) {
      return undefined;
    }
    return trimmed;
  }

  private async validateAccess(
    userId: string,
    projectId?: string,
    chatId?: string,
    pageId?: string,
  ): Promise<void> {
    const cleanProjectId = this.sanitizeProjectId(projectId);
    if (cleanProjectId) {
      const project = await this.prisma.project.findFirst({
        where: {
          id: cleanProjectId,
          deletedAt: null,
          OR: [{ members: { some: { userId } } }, { createdById: userId }],
        },
      });
      if (!project) {
        throw new ForbiddenException('You do not have access to this project');
      }
    }

    if (chatId && this.isValidUuid(chatId)) {
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
      const doc =
        (await (this.prisma as any).manuscriptDoc?.findFirst?.({
          where: { id: pageId, deleted: false },
          select: { id: true, projectId: true, authorId: true },
        })) ||
        (await (this.prisma as any).page?.findFirst?.({
          where: { id: pageId },
          select: { id: true, projectId: true, authorId: true },
        }));
      if (!doc) {
        throw new NotFoundException('Manuscript doc not found');
      }
      if (doc.projectId) {
        const project = await this.prisma.project.findFirst({
          where: { id: doc.projectId },
          select: {
            createdById: true,
            members: { where: { userId }, select: { userId: true } },
          },
        });
        const canAccess =
          project?.createdById === userId ||
          (project?.members && project.members.length > 0);
        if (!canAccess) {
          throw new ForbiddenException(
            'You do not have access to this manuscript document',
          );
        }
      } else if (doc.authorId && doc.authorId !== userId) {
        throw new ForbiddenException(
          'You do not have access to this manuscript document',
        );
      }
    }
  }

  /**
   * Resolves storage file IDs to their underlying Vector RAG document IDs (ragDocId).
   */
  private async resolveDocumentIds(documentIds: string[]): Promise<string[]> {
    if (!documentIds || documentIds.length === 0) return [];

    const fileMap = new Map<string, string>();

    // 1. Storage Files
    const files = await this.prisma.file.findMany({
      where: { id: { in: documentIds } },
      select: { id: true, metaData: true },
    });
    for (const f of files) {
      const meta = f.metaData as Record<string, any> | null;
      if (meta?.ragDocId) {
        fileMap.set(f.id, meta.ragDocId);
      }
    }

    // 2. Library Items
    const missingForItems = documentIds.filter((id) => !fileMap.has(id));
    if (missingForItems.length > 0) {
      const items = await (this.prisma as any).item?.findMany({
        where: { id: { in: missingForItems } },
        include: {
          attachments: {
            where: { deletedAt: null },
            select: { fileId: true, metadata: true, attachmentType: true },
          },
        },
      });

      if (items) {
        for (const it of items) {
          const itMeta = it.metadata as Record<string, any> | null;
          if (itMeta?.ragDocId) {
            fileMap.set(it.id, itMeta.ragDocId);
            continue;
          }
          if (it.attachments && it.attachments.length > 0) {
            const att =
              it.attachments.find(
                (a: any) => a.attachmentType === 'primary_pdf',
              ) || it.attachments[0];
            const attMeta = att.metadata as Record<string, any> | null;
            if (attMeta?.ragDocId) {
              fileMap.set(it.id, attMeta.ragDocId);
            } else if (att.fileId) {
              const file = await this.prisma.file.findUnique({
                where: { id: att.fileId },
                select: { metaData: true },
              });
              const fMeta = file?.metaData as Record<string, any> | null;
              if (fMeta?.ragDocId) {
                fileMap.set(it.id, fMeta.ragDocId);
              }
            }
          }
        }
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

    const payload = buildAiPayload(userId, dto);

    // Validate that user message is not empty early before DB calls
    const userMessages = payload.messages.filter((m) => m.role === 'user');
    const lastUserMsg = userMessages[userMessages.length - 1];
    if (!lastUserMsg || !lastUserMsg.content || !lastUserMsg.content.trim()) {
      throw new UnprocessableEntityException('Message content cannot be empty');
    }

    // Parallel pre-flight: execute access check and document ID resolution simultaneously
    const [_, resolvedDocIds] = await Promise.all([
      this.validateAccess(userId, targetProjectId, targetChatId, targetPageId),
      payload.document_ids && payload.document_ids.length > 0
        ? this.resolveDocumentIds(payload.document_ids)
        : Promise.resolve([]),
    ]);
    if (payload.document_ids && payload.document_ids.length > 0) {
      payload.document_ids = resolvedDocIds;
    }

    // Resolve or establish authoritative chat session
    let effectiveTitle = 'New Chat';
    if (targetPageId) {
      const pageSession = await this.chatService.getOrCreatePageChat(
        targetPageId,
        userId,
        targetProjectId,
      );
      targetChatId = pageSession.id;
      effectiveTitle = pageSession.title;
    } else if (!targetChatId) {
      effectiveTitle = this.deriveInitialChatTitle(
        lastUserMsg.content,
        payload.document_ids,
      );
      const newSession = await this.chatService.createChat(userId, {
        projectId: targetProjectId,
        title: effectiveTitle,
        documentIds: payload.document_ids,
      });
      targetChatId = newSession.id;
    }

    payload.chat_id = targetChatId;

    // Concurrent user message append without blocking SSE stream initiation
    const persistUserMsgPromise = this.chatService
      .appendMessages(targetChatId, userId, {
        messages: [
          {
            role: 'user',
            content: lastUserMsg.content,
            ...((lastUserMsg as any).attachments || (lastUserMsg as any).sources
              ? {
                  sources:
                    (lastUserMsg as any).attachments ||
                    (lastUserMsg as any).sources,
                }
              : {}),
          },
        ],
        documentIds: payload.document_ids,
      })
      .catch((err) => {
        this.logger.warn(
          `Could not persist user message to thread: ${String(err)}`,
        );
      });

    const initialEvents = [
      `data: [META]${JSON.stringify({
        chatId: targetChatId,
        title: effectiveTitle,
      })}\n\n`,
    ];

    const onComplete = async (accumulatedText: string) => {
      await persistUserMsgPromise;
      if (targetChatId && accumulatedText && accumulatedText.trim()) {
        try {
          await this.chatService.appendMessages(targetChatId, userId, {
            messages: [{ role: 'assistant', content: accumulatedText }],
            documentIds: payload.document_ids,
          });
        } catch (err) {
          this.logger.warn(
            `Could not persist assistant stream response: ${String(err)}`,
          );
        }

        // Auto-generate conversation title based on exchange
        void this.generateAndSaveConversationTitle(
          targetChatId,
          userId,
          lastUserMsg.content,
          accumulatedText,
          effectiveTitle,
          payload.document_ids,
        );
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

    const payload = buildAiPayload(userId, dto);

    // Validate that user message is not empty early before DB calls
    const userMessages = payload.messages.filter((m) => m.role === 'user');
    const lastUserMsg = userMessages[userMessages.length - 1];
    if (!lastUserMsg || !lastUserMsg.content || !lastUserMsg.content.trim()) {
      throw new UnprocessableEntityException('Message content cannot be empty');
    }

    // Parallel pre-flight: execute access check and document ID resolution simultaneously
    const [_, resolvedDocIds] = await Promise.all([
      this.validateAccess(userId, targetProjectId, targetChatId, targetPageId),
      payload.document_ids && payload.document_ids.length > 0
        ? this.resolveDocumentIds(payload.document_ids)
        : Promise.resolve([]),
    ]);
    if (payload.document_ids && payload.document_ids.length > 0) {
      payload.document_ids = resolvedDocIds;
    }

    // Resolve or establish authoritative chat session
    let effectiveTitle = 'New Chat';
    if (targetPageId) {
      const pageSession = await this.chatService.getOrCreatePageChat(
        targetPageId,
        userId,
        targetProjectId,
      );
      targetChatId = pageSession.id;
      effectiveTitle = pageSession.title;
    } else if (!targetChatId) {
      effectiveTitle = this.deriveInitialChatTitle(
        lastUserMsg.content,
        payload.document_ids,
      );
      const newSession = await this.chatService.createChat(userId, {
        projectId: targetProjectId,
        title: effectiveTitle,
        documentIds: payload.document_ids,
      });
      targetChatId = newSession.id;
    }

    payload.chat_id = targetChatId;

    // Save user message to thread
    try {
      await this.chatService.appendMessages(targetChatId, userId, {
        messages: [
          {
            role: 'user',
            content: lastUserMsg.content,
            ...((lastUserMsg as any).attachments || (lastUserMsg as any).sources
              ? {
                  sources:
                    (lastUserMsg as any).attachments ||
                    (lastUserMsg as any).sources,
                }
              : {}),
          },
        ],
        documentIds: payload.document_ids,
      });
    } catch (err) {
      this.logger.warn(
        `Could not persist user message to thread: ${String(err)}`,
      );
    }

    const result = await this.engineService.syncChat(payload);

    if (targetChatId && result.content && result.content.trim()) {
      try {
        await this.chatService.appendMessages(targetChatId, userId, {
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
        this.logger.warn(
          `Could not persist assistant sync response: ${String(err)}`,
        );
      }

      // Auto-generate conversation title based on exchange
      void this.generateAndSaveConversationTitle(
        targetChatId,
        userId,
        lastUserMsg.content,
        result.content,
        effectiveTitle,
        payload.document_ids,
      );
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
      include: {
        contributors: { orderBy: { orderIndex: 'asc' } },
        attachments: {
          where: { deletedAt: null },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (item) {
      const hasAccess =
        item.userId === userId ||
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

      // Priority resolution of ragDocId:
      // a) check item.metadata.ragDocId
      let ragDocId: string | null =
        (item.metadata as Record<string, any>)?.ragDocId ||
        item.ragDocId ||
        null;

      // b) check primary_pdf attachment or any attachment
      if (!ragDocId && item.attachments && item.attachments.length > 0) {
        const primaryAtt =
          item.attachments.find(
            (a: any) => a.attachmentType === 'primary_pdf',
          ) || item.attachments[0];

        const attMeta = (primaryAtt?.metadata as Record<string, any>) || {};
        if (attMeta.ragDocId) {
          ragDocId = attMeta.ragDocId;
        } else if (primaryAtt?.fileId) {
          const file = await this.prisma.file.findUnique({
            where: { id: primaryAtt.fileId },
            select: { metaData: true },
          });
          const fileMeta = (file?.metaData as Record<string, any>) || {};
          if (fileMeta.ragDocId) {
            ragDocId = fileMeta.ragDocId;
          }
        }
      }

      return {
        title: item.title,
        authors: item.contributors?.map((c: any) => c.fullName) || [],
        year: item.year || undefined,
        doi: item.doi || undefined,
        abstract: item.abstract || undefined,
        ragDocId,
        scopeId: item.projectId || userId,
      };
    }

    // 2. Try finding Storage File directly
    const file = await this.prisma.file.findFirst({
      where: { id: paperOrFileId, trashedAt: null },
      include: {
        sharedWith: { where: { userId } },
      },
    });

    if (file) {
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

    // 3. Try finding by Attachment ID
    const attachment = await (this.prisma as any).attachment?.findFirst({
      where: { id: paperOrFileId, deletedAt: null },
      select: { itemId: true },
    });

    if (attachment?.itemId) {
      return this.resolvePaperTarget(userId, attachment.itemId);
    }

    throw new NotFoundException(
      `Paper or scientific file with ID ${paperOrFileId} not found`,
    );
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
    if (chatId && this.isValidUuid(chatId)) {
      const existingChat = await this.prisma.aiChat.findFirst({
        where: { id: chatId },
      });
      if (existingChat && existingChat.userId !== userId) {
        throw new ForbiddenException(
          'You do not have access to this chat session',
        );
      }
    } else if (!chatId) {
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
    if (chatId && this.isValidUuid(chatId)) {
      const existingChat = await this.prisma.aiChat.findFirst({
        where: { id: chatId },
      });
      if (existingChat && existingChat.userId !== userId) {
        throw new ForbiddenException(
          'You do not have access to this chat session',
        );
      }
    } else if (!chatId) {
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
    payload.document_ids = resolved.ragDocId ? [resolved.ragDocId] : [];
    payload.chat_id = chatId;
    payload.intent_hint = 'paper_rag_qa';

    if (paperContext) {
      payload.messages = [
        { role: 'system' as const, content: paperContext },
        ...payload.messages,
      ];
    }

    const cleanQuery = (
      dto.query ||
      dto.messages?.[dto.messages.length - 1]?.content ||
      ''
    ).trim();
    const cacheKey =
      this.redis && cleanQuery
        ? `ai:paper-qa:${resolved.scopeId}:${resolved.ragDocId || paperId}:${crypto.createHash('sha256').update(cleanQuery).digest('hex')}`
        : null;

    if (cacheKey && this.redis) {
      return this.redis.wrap(
        cacheKey,
        () => this.engineService.syncChat(payload),
        3600,
      );
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
    const cleanProjectId = this.sanitizeProjectId(options?.projectId);
    const cleanChatId =
      options?.chatId && this.isValidUuid(options.chatId)
        ? options.chatId
        : undefined;

    const rawScope = options?.scopeId;
    const isPersonalScope =
      !rawScope ||
      rawScope === 'me' ||
      rawScope === 'user' ||
      rawScope === 'all';
    const scopeId = isPersonalScope ? cleanProjectId || userId : rawScope;

    await this.validateAccess(userId, cleanProjectId, cleanChatId);
    return this.engineService.uploadDocument(
      fileBuffer,
      contentType,
      filename,
      {
        userId,
        scopeId,
        projectId: cleanProjectId,
        chatId: cleanChatId,
        title: options?.title,
        tags: options?.tags,
      },
    );
  }

  async getDocumentsBulk(userId: string, ids: string[], projectId?: string) {
    const cleanProjectId = this.sanitizeProjectId(projectId);
    await this.validateAccess(userId, cleanProjectId);
    const scopeId = cleanProjectId || userId;
    return this.engineService.getDocumentsBulk(ids, {
      userId,
      scopeId,
      projectId: cleanProjectId,
    });
  }

  async getDocument(userId: string, docId: string, projectId?: string) {
    const cleanProjectId = this.sanitizeProjectId(projectId);
    await this.validateAccess(userId, cleanProjectId);
    const scopeId = cleanProjectId || userId;
    return this.engineService.getDocument(docId, {
      userId,
      scopeId,
      projectId: cleanProjectId,
    });
  }

  async getDocuments(userId: string, projectId?: string) {
    const cleanProjectId = this.sanitizeProjectId(projectId);
    await this.validateAccess(userId, cleanProjectId);
    const scopeId = cleanProjectId || userId;
    return this.engineService.getDocuments({
      userId,
      scopeId,
      projectId: cleanProjectId,
    });
  }

  async deleteDocument(userId: string, docId: string, projectId?: string) {
    const cleanProjectId = this.sanitizeProjectId(projectId);
    await this.validateAccess(userId, cleanProjectId);
    const scopeId = cleanProjectId || userId;
    return this.engineService.deleteDocument(docId, {
      userId,
      scopeId,
      projectId: cleanProjectId,
    });
  }

  /**
   * Derive initial title when session starts, avoiding raw greetings or generic phrases.
   */
  private deriveInitialChatTitle(
    content: string,
    documentIds?: string[],
  ): string {
    const trimmed = (content || '').trim();
    const lower = trimmed.toLowerCase();

    // Check if user content is a pure greeting or generic trigger
    const GREETING_REGEX =
      /^(xin chào|chào bạn|chào|hello|hi|hey|alo|good morning|good afternoon|good evening|tóm tắt tôi file này|tóm tắt file này|tóm tắt paper này)[!.,? ]*$/i;

    if (!trimmed || GREETING_REGEX.test(lower)) {
      if (documentIds && documentIds.length > 0) {
        return 'Tài liệu đính kèm';
      }
      return 'New Chat';
    }

    return sanitizeChatTitle(trimmed);
  }

  /**
   * Auto-generate a concise, meaningful title (3 to 6 words) based on the actual
   * conversation topic, updating the chat session in background.
   */
  private async generateAndSaveConversationTitle(
    chatId: string,
    userId: string,
    userText: string,
    assistantText: string,
    currentTitle?: string,
    documentIds?: string[],
  ): Promise<void> {
    try {
      // Determine if title needs summarization
      const isGeneric =
        !currentTitle ||
        currentTitle.trim() === 'New Chat' ||
        currentTitle.trim() === 'Tài liệu đính kèm' ||
        /^(xin chào|chào bạn|chào|hello|hi|hey|alo|tóm tắt tôi file này|tóm tắt file này|tóm tắt paper này)[!.,? ]*$/i.test(
          currentTitle.trim(),
        );

      if (!isGeneric) return;

      // 1. If documentIds exist, try to name after the first document
      if (documentIds && documentIds.length > 0) {
        const file = await this.prisma.file.findFirst({
          where: { id: { in: documentIds } },
          select: { filename: true },
        });
        const docName = file?.filename;
        if (docName) {
          const cleanDocTitle = sanitizeChatTitle(docName).slice(0, 45);
          const newTitle = `Tài liệu: ${cleanDocTitle}`;
          await this.chatService.renameChat(chatId, userId, {
            title: newTitle,
          });
          return;
        }
      }

      // 2. Call LLM to summarize conversation topic into a clean 3-6 word title
      const prompt = `Generate a concise, professional title (3 to 6 words maximum, in the same language as the conversation, no quotes, no trailing punctuation) summarizing the main topic of this conversation:\n\nUser: ${userText.slice(0, 400)}\nAssistant: ${assistantText.slice(0, 600)}`;

      const response = await this.engineService.syncChat({
        messages: [{ role: 'user', content: prompt }],
      });

      if (response && response.content) {
        let clean = response.content
          .replace(/^["'`“”«»]+|["'`“”«»]+$/g, '')
          .replace(/[.!?:;]+$/, '')
          .trim();
        clean = clean
          .replace(/^[#*\-•\s]+/, '')
          .replace(/[*_~`]/g, '')
          .trim();

        if (
          clean.length > 0 &&
          clean.length <= 60 &&
          !clean.toLowerCase().includes('offline') &&
          !clean.toLowerCase().includes('flux-ai')
        ) {
          await this.chatService.renameChat(chatId, userId, {
            title: clean,
          });
          return;
        }
      }

      // 3. Heuristic fallback
      const heuristicTitle = this.extractHeuristicTitle(
        userText,
        assistantText,
      );
      if (heuristicTitle && heuristicTitle !== currentTitle) {
        await this.chatService.renameChat(chatId, userId, {
          title: heuristicTitle,
        });
      }
    } catch (err) {
      this.logger.warn(
        `Could not auto-generate conversation title: ${String(err)}`,
      );
    }
  }

  private extractHeuristicTitle(
    userText: string,
    assistantText: string,
  ): string {
    const cleanUser = (userText || '')
      .replace(
        /^(xin chào|chào bạn|chào|hello|hi|hey|alo|cho tôi hỏi|hãy cho tôi biết|hãy|bạn có thể)\s+/i,
        '',
      )
      .trim();

    if (cleanUser.length >= 5) {
      return sanitizeChatTitle(cleanUser).slice(0, 50);
    }

    if (assistantText && assistantText.length > 10) {
      const firstLine = assistantText
        .split('\n')[0]
        .replace(/^[#*\-•\s]+/, '')
        .trim();
      if (firstLine.length >= 5) {
        return sanitizeChatTitle(firstLine).slice(0, 50);
      }
    }

    return 'Cuộc trò chuyện mới';
  }
}
