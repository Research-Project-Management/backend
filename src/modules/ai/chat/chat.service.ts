import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  UnprocessableEntityException,
  Optional,
  Logger,
} from '@nestjs/common';
import { ChatRepository } from './chat.repository';
import {
  CreateChatDto,
  AppendMessagesDto,
  RenameChatDto,
} from './dto/chat.dto';
import { RedisCacheService } from '@/core';
import { AI_REDIS_KEYS } from './constants/redis-keys.constant';
import { PrismaService } from '@/core';
import {
  normalizeProjectId,
  sanitizeChatTitle,
  sanitizeChatMessageContent,
  validateAndSanitizeRole,
} from '../utils/ai.util';
import { Prisma } from '@prisma/client';
import { FormattedChatSession, ChatWithMessages } from './types/chat.type';
import { EngineService } from '../engine/engine.service';

export type { FormattedChatSession };

function formatChat(chat: ChatWithMessages): FormattedChatSession {
  const msgs = Array.isArray(chat.messages) ? chat.messages : [];
  const lastMsg = msgs.length > 0 ? msgs[msgs.length - 1].content || '' : '';
  const projectId =
    chat.spaceId && chat.spaceId !== chat.createdById ? chat.spaceId : null;

  return {
    id: chat.id,
    title: chat.title,
    spaceId: chat.spaceId,
    projectId,
    pageId: chat.pageId,
    scopeSlug: chat.spaceId || chat.createdById,
    messageCount: msgs.length,
    lastMessage: lastMsg,
    documentIds: chat.documentIds || [],
    createdAt: chat.createdAt?.toISOString?.() || String(chat.createdAt),
    updatedAt: chat.updatedAt?.toISOString?.() || String(chat.updatedAt),
    messages: msgs.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      sources: m.role === 'assistant' ? m.sources : undefined,
      attachments:
        m.role === 'user' && Array.isArray(m.sources) && m.sources.length > 0
          ? m.sources
          : undefined,
      widgets: m.widgets,
      createdAt: m.createdAt?.toISOString?.() || String(m.createdAt),
    })),
  };
}

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    private readonly chatRepo: ChatRepository,
    private readonly prisma: PrismaService,
    @Optional() private readonly cache?: RedisCacheService,
    @Optional() private readonly engineService?: EngineService,
  ) {}

  private async invalidateChatCache(
    userId: string,
    chatId?: string,
    projectId?: string | null,
  ) {
    if (!this.cache) return;
    const promises: Promise<unknown>[] = [
      this.cache.del(AI_REDIS_KEYS.userChats(userId, projectId)),
      this.cache.del(AI_REDIS_KEYS.userChats(userId, null)),
    ];
    if (chatId) {
      promises.push(this.cache.del(AI_REDIS_KEYS.chatSession(chatId)));
      promises.push(
        this.cache.del(`${AI_REDIS_KEYS.chatSession(chatId)}:${userId}`),
      );
    }
    await Promise.all(promises).catch((err) => {
      this.logger.warn(`Failed to invalidate AI chat cache: ${err}`);
    });
  }

  private sanitizeProjectId(
    projectId?: string | null,
    userId?: string | null,
  ): string | null {
    return normalizeProjectId(projectId, userId) ?? null;
  }

  private async resolveValidSpaceUuid(
    userId: string,
    rawSpaceId?: string | null,
  ): Promise<{ spaceId: string; projectId: string | null }> {
    const cleanAlias = this.sanitizeProjectId(rawSpaceId, userId);

    if (!cleanAlias) {
      const personalSpace = await Promise.resolve(
        this.prisma.space?.findFirst?.({
          where: {
            OR: [{ id: userId }, { ownerUserId: userId, type: 'personal' }],
          },
          select: { id: true },
        }),
      ).catch(() => null);
      return {
        spaceId: personalSpace?.id || userId,
        projectId: null,
      };
    }

    const space = await Promise.resolve(
      this.prisma.space?.findFirst?.({
        where: { OR: [{ id: cleanAlias }, { projectId: cleanAlias }] },
        select: {
          id: true,
          type: true,
          ownerUserId: true,
          projectId: true,
        },
      }),
    ).catch(() => null);

    if (space) {
      if (space.type === 'personal') {
        if (space.ownerUserId && space.ownerUserId !== userId) {
          throw new ForbiddenException(
            'User does not have access to this workspace',
          );
        }
        return { spaceId: space.id, projectId: null };
      }

      if (space.projectId) {
        const project = await this.prisma.project.findFirst({
          where: {
            id: space.projectId,
            deletedAt: null,
            OR: [{ createdById: userId }, { members: { some: { userId } } }],
          },
          select: { id: true },
        });
        if (!project) {
          throw new ForbiddenException(
            'User does not have access to this project',
          );
        }
        return { spaceId: space.id, projectId: project.id };
      }
    }

    const isUuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        cleanAlias,
      );
    const project = await this.prisma.project.findFirst({
      where: {
        OR: [
          ...(isUuid ? [{ id: cleanAlias }] : []),
          { identifier: cleanAlias },
        ],
        deletedAt: null,
        AND: [
          {
            OR: [{ createdById: userId }, { members: { some: { userId } } }],
          },
        ],
      },
      select: { id: true, identifier: true, space: { select: { id: true } } },
    });
    if (!project) {
      throw new ForbiddenException('User does not have access to this project');
    }

    return {
      spaceId: project.space?.id || project.id,
      projectId: project.id,
    };
  }

  private async canonicalizeAndVerifyPageAccess(
    pageId: string,
    userId: string,
    fallbackSpaceId?: string | null,
  ): Promise<{
    canonicalPageId: string;
    spaceId: string;
    projectId: string | null;
    titleHint: string | null;
  }> {
    const page = await Promise.resolve(
      this.prisma.page?.findFirst?.({
        where: { id: pageId, deletedAt: null },
        select: { id: true, title: true, spaceId: true },
      }),
    ).catch(() => null);

    const doc = !page
      ? await Promise.resolve(
          this.prisma.pageDoc?.findFirst?.({
            where: { id: pageId, deletedAt: null },
            select: {
              id: true,
              pageId: true,
              spaceId: true,
              lastKnownPath: true,
              node: { select: { path: true } },
            },
          }),
        ).catch(() => null)
      : null;

    const hasDelegate = Boolean(
      this.prisma.page?.findFirst || this.prisma.pageDoc?.findFirst,
    );
    if (hasDelegate && !page && !doc) {
      throw new NotFoundException('Manuscript page not found');
    }

    const canonicalPageId =
      page?.id ||
      (doc as { pageId?: string | null } | null)?.pageId ||
      doc?.id ||
      pageId;
    const rawSpaceId =
      page?.spaceId ||
      doc?.spaceId ||
      (doc as { projectId?: string | null } | null)?.projectId ||
      fallbackSpaceId;

    const resolvedSpace = await this.resolveValidSpaceUuid(userId, rawSpaceId);
    const titleHint =
      page?.title || doc?.node?.path || doc?.lastKnownPath || null;

    return {
      canonicalPageId,
      spaceId: resolvedSpace.spaceId,
      projectId: resolvedSpace.projectId,
      titleHint,
    };
  }

  async getChats(
    userId: string,
    projectId?: string | null,
  ): Promise<FormattedChatSession[]> {
    const resolvedScope = await this.resolveValidSpaceUuid(userId, projectId);
    const cleanProjectId = resolvedScope.projectId ?? resolvedScope.spaceId;

    const cacheKey = AI_REDIS_KEYS.userChats(userId, cleanProjectId);
    if (this.cache) {
      const cached = await this.cache.get<FormattedChatSession[]>(cacheKey);
      if (cached) return cached;
    }

    const rawChats = await this.chatRepo.findUserChats(
      userId,
      resolvedScope.spaceId,
    );
    const result = rawChats.map(formatChat);

    if (this.cache) {
      await this.cache.set(cacheKey, result, 1800);
    }

    return result;
  }

  async getPageChat(pageId: string, userId: string) {
    if (!pageId) {
      throw new BadRequestException('pageId is required');
    }
    const pageMeta = await this.canonicalizeAndVerifyPageAccess(pageId, userId);
    const raw = await this.chatRepo.findPageChat(
      pageMeta.canonicalPageId,
      userId,
    );
    const formatted = raw ? formatChat(raw) : null;
    return {
      chat: formatted,
      messages: formatted?.messages || [],
    };
  }

  async clearPageChat(pageId: string, userId: string) {
    if (!pageId) {
      throw new BadRequestException('pageId is required');
    }
    const pageMeta = await this.canonicalizeAndVerifyPageAccess(pageId, userId);
    const result = await this.chatRepo.deletePageChat(
      pageMeta.canonicalPageId,
      userId,
    );
    if (result.chatIds && result.chatIds.length > 0) {
      await Promise.all([
        ...result.chatIds.map((id) =>
          this.engineService
            ?.deleteDocumentsByChat(id, userId)
            .catch(() => undefined),
        ),
        ...result.chatIds.map((id) =>
          this.invalidateChatCache(userId, id, pageMeta.spaceId),
        ),
      ]);
    } else {
      await this.invalidateChatCache(userId, undefined, pageMeta.spaceId);
    }
    return { success: true };
  }

  async getOrCreatePageChat(
    pageId: string,
    userId: string,
    projectId?: string | null,
  ): Promise<FormattedChatSession> {
    if (!pageId) {
      throw new BadRequestException('pageId is required');
    }
    const pageMeta = await this.canonicalizeAndVerifyPageAccess(
      pageId,
      userId,
      projectId,
    );
    const raw = await this.chatRepo.findPageChat(
      pageMeta.canonicalPageId,
      userId,
    );
    if (raw) {
      return formatChat(raw);
    }

    const title = pageMeta.titleHint
      ? `${sanitizeChatTitle(pageMeta.titleHint)} Discussion`
      : 'Manuscript Chat';

    const created = await this.chatRepo.createChat({
      createdById: userId,
      spaceId: pageMeta.spaceId,
      pageId: pageMeta.canonicalPageId,
      title,
    });

    await this.invalidateChatCache(userId, created.id, pageMeta.spaceId);
    return formatChat(created);
  }

  async getChat(chatId: string, userId: string): Promise<FormattedChatSession> {
    const cacheKey = `${AI_REDIS_KEYS.chatSession(chatId)}:${userId}`;
    if (this.cache) {
      const cached = await this.cache.get<FormattedChatSession>(cacheKey);
      if (cached) return cached;
    }

    const raw = await this.chatRepo.findChatByIdAndUser(chatId, userId);
    if (!raw) {
      throw new NotFoundException('Chat not found');
    }

    const result = formatChat(raw);
    if (this.cache) {
      await this.cache.set(cacheKey, result, 1800);
    }

    return result;
  }

  async createChat(
    userId: string,
    dto: CreateChatDto,
  ): Promise<FormattedChatSession> {
    let resolvedScope = await this.resolveValidSpaceUuid(userId, dto.spaceId);
    let canonicalPageId = dto.pageId;

    // Verify document access if specified
    if (dto.pageId) {
      const pageMeta = await this.canonicalizeAndVerifyPageAccess(
        dto.pageId,
        userId,
        dto.spaceId,
      );
      canonicalPageId = pageMeta.canonicalPageId;
      resolvedScope = {
        spaceId: pageMeta.spaceId,
        projectId: pageMeta.projectId,
      };
    }

    const created = await this.chatRepo.createChat({
      createdById: userId,
      spaceId: resolvedScope.spaceId,
      pageId: canonicalPageId,
      title: sanitizeChatTitle(dto.title),
      documentIds: dto.documentIds,
    });

    if (dto.messages && dto.messages.length > 0) {
      const formattedMessages = dto.messages.map((m) => ({
        role: validateAndSanitizeRole(m.role),
        content: sanitizeChatMessageContent(m.content),
        sources: (m.attachments || m.sources) as
          Prisma.InputJsonValue | undefined,
        widgets: m.widgets as Prisma.InputJsonValue | undefined,
        selectionContext: m.selectionContext as
          Prisma.InputJsonValue | undefined,
      }));
      const updated = await this.chatRepo.createMessages(
        created.id,
        formattedMessages,
        dto.documentIds,
      );
      if (!updated) {
        throw new NotFoundException('Chat not found');
      }
      const result = formatChat(updated);
      await this.invalidateChatCache(userId, created.id, resolvedScope.spaceId);
      return result;
    }

    const result = formatChat(created);
    await this.invalidateChatCache(userId, created.id, resolvedScope.spaceId);
    return result;
  }

  async appendMessages(
    chatId: string,
    userId: string,
    dto: AppendMessagesDto,
  ): Promise<FormattedChatSession> {
    const chat = await this.chatRepo.findChatByIdAndUser(chatId, userId);
    if (!chat) {
      throw new NotFoundException('Chat not found');
    }

    if (!dto.messages || dto.messages.length === 0) {
      throw new UnprocessableEntityException('Messages array cannot be empty');
    }

    const formattedMessages = dto.messages.map((m) => ({
      role: validateAndSanitizeRole(m.role),
      content: sanitizeChatMessageContent(m.content),
      sources: (m.attachments || m.sources) as
        Prisma.InputJsonValue | undefined,
      widgets: m.widgets as Prisma.InputJsonValue | undefined,
      selectionContext: m.selectionContext as Prisma.InputJsonValue | undefined,
    }));

    if (formattedMessages.some((m) => !m.content || !m.content.trim())) {
      throw new UnprocessableEntityException('Message content cannot be empty');
    }

    const updated = await this.chatRepo.createMessages(
      chatId,
      formattedMessages,
      dto.documentIds,
    );
    if (!updated) {
      throw new NotFoundException('Chat not found');
    }
    const result = formatChat(updated);
    const projectId =
      chat.spaceId && chat.spaceId !== chat.createdById ? chat.spaceId : null;

    await this.invalidateChatCache(chat.createdById, chatId, projectId);

    return result;
  }

  async renameChat(
    chatId: string,
    userId: string,
    dto: RenameChatDto,
  ): Promise<FormattedChatSession> {
    const chat = await this.chatRepo.findChatByIdAndUser(chatId, userId);
    if (!chat) {
      throw new NotFoundException('Chat not found');
    }

    const cleanTitle = sanitizeChatTitle(dto.title);
    const updated = await this.chatRepo.updateChatTitle(chatId, cleanTitle);
    const result = formatChat(updated);
    const projectId =
      chat.spaceId && chat.spaceId !== chat.createdById ? chat.spaceId : null;

    await this.invalidateChatCache(chat.createdById, chatId, projectId);

    return result;
  }

  async deleteChat(chatId: string, userId: string) {
    const chat = await this.chatRepo.findChatByIdAndUser(chatId, userId);
    if (!chat) {
      throw new NotFoundException('Chat not found');
    }
    await this.chatRepo.deleteChat(chatId);
    await this.engineService?.deleteDocumentsByChat(chatId, userId);
    const projectId =
      chat.spaceId && chat.spaceId !== chat.createdById ? chat.spaceId : null;

    await this.invalidateChatCache(chat.createdById, chatId, projectId);

    return { success: true };
  }

  async clearMemory(userId: string, scopeId?: string) {
    const rawTarget =
      scopeId && scopeId !== 'clear' && scopeId !== userId ? scopeId : null;
    const resolvedScope = await this.resolveValidSpaceUuid(userId, rawTarget);
    await this.chatRepo.clearUserChats(userId, resolvedScope.spaceId);
    await this.invalidateChatCache(
      userId,
      undefined,
      resolvedScope.projectId ?? resolvedScope.spaceId,
    );
    return { success: true };
  }
}
