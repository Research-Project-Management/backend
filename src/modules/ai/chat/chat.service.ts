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
import { RedisCacheService } from '@/core/cache/redis.service';
import { AI_REDIS_KEYS } from './constants/redis-keys.constant';
import { PrismaService } from '@/core/database/prisma.service';
import {
  sanitizeChatTitle,
  sanitizeChatMessageContent,
  validateAndSanitizeRole,
} from '../utils/ai.util';
import { FormattedChatSession } from './types/chat.type';

export type { FormattedChatSession };

function formatChat(chat: any): FormattedChatSession {
  const msgs = chat.messages || [];
  const lastMsg = msgs.length > 0 ? msgs[msgs.length - 1].content || '' : '';

  return {
    id: chat.id,
    title: chat.title,
    projectId: chat.projectId,
    pageId: chat.pageId,
    scopeSlug: chat.projectId || chat.userId,
    messageCount: msgs.length,
    lastMessage: lastMsg,
    documentIds: chat.documentIds || [],
    createdAt: chat.createdAt?.toISOString?.() || chat.createdAt,
    updatedAt: chat.updatedAt?.toISOString?.() || chat.updatedAt,
    messages: msgs.map((m: any) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      sources: m.sources,
      widgets: m.widgets,
      createdAt: m.createdAt?.toISOString?.() || m.createdAt,
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
  ) {}

  private async invalidateChatCache(
    userId: string,
    chatId?: string,
    projectId?: string | null,
  ) {
    if (!this.cache) return;
    const promises: Promise<any>[] = [
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

  private sanitizeProjectId(projectId?: string | null): string | null {
    if (!projectId) return null;
    const trimmed = projectId.trim();
    if (
      trimmed === 'me' ||
      trimmed === 'user' ||
      trimmed === 'all' ||
      trimmed === 'null' ||
      trimmed === 'undefined'
    ) {
      return null;
    }
    const isUuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        trimmed,
      );
    return isUuid ? trimmed : null;
  }

  async getChats(
    userId: string,
    projectId?: string | null,
  ): Promise<FormattedChatSession[]> {
    const cleanProjectId = this.sanitizeProjectId(projectId);
    if (cleanProjectId) {
      const project = await this.prisma.project.findFirst({
        where: {
          id: cleanProjectId,
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
    }

    const cacheKey = AI_REDIS_KEYS.userChats(userId, cleanProjectId);
    if (this.cache) {
      const cached = await this.cache.get<FormattedChatSession[]>(cacheKey);
      if (cached) return cached;
    }

    const rawChats = await this.chatRepo.findUserChats(userId, projectId);
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
    const raw = await this.chatRepo.findPageChat(pageId, userId);
    return {
      chat: raw ? formatChat(raw) : null,
      messages: raw?.messages || [],
    };
  }

  async clearPageChat(pageId: string, userId: string) {
    if (!pageId) {
      throw new BadRequestException('pageId is required');
    }
    await this.chatRepo.deletePageChat(pageId, userId);
    await this.invalidateChatCache(userId);
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
    const raw = await this.chatRepo.findPageChat(pageId, userId);
    if (raw) {
      return formatChat(raw);
    }

    const doc = await this.prisma.manuscriptDoc.findUnique({
      where: { id: pageId },
      select: { path: true, projectId: true },
    });

    const title = doc?.path
      ? `${sanitizeChatTitle(doc.path)} Discussion`
      : 'Manuscript Chat';
    const effectiveProjectId = projectId || doc?.projectId || null;

    const created = await this.chatRepo.createChat({
      userId,
      projectId: effectiveProjectId,
      pageId,
      title,
    });

    await this.invalidateChatCache(userId, created.id, effectiveProjectId);
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
    const cleanProjectId = this.sanitizeProjectId(dto.projectId);
    // Verify project access if specified
    if (cleanProjectId) {
      const project = await this.prisma.project.findFirst({
        where: {
          id: cleanProjectId,
          deletedAt: null,
          OR: [{ createdById: userId }, { members: { some: { userId } } }],
        },
        select: { id: true, identifier: true },
      });
      if (!project) {
        throw new ForbiddenException(
          'User does not have access to this project',
        );
      }
    }

    // Verify document access if specified
    if (dto.pageId) {
      const doc = await this.prisma.manuscriptDoc.findFirst({
        where: { id: dto.pageId, deleted: false },
        select: { id: true, projectId: true },
      });
      if (!doc) {
        throw new NotFoundException('Manuscript doc not found');
      }
      const project = await this.prisma.project.findFirst({
        where: { id: doc.projectId },
        select: {
          id: true,
          identifier: true,
          createdById: true,
          members: { where: { userId }, select: { userId: true } },
        },
      });
      const canAccess =
        project?.createdById === userId ||
        (project?.members && project.members.length > 0);
      if (!canAccess) {
        throw new ForbiddenException(
          'User does not have access to this manuscript document',
        );
      }
    }

    const created = await this.chatRepo.createChat({
      userId,
      projectId: cleanProjectId,
      pageId: dto.pageId,
      title: sanitizeChatTitle(dto.title),
      documentIds: dto.documentIds,
    });

    if (dto.messages && dto.messages.length > 0) {
      const formattedMessages = dto.messages.map((m: any) => ({
        role: validateAndSanitizeRole(m.role),
        content: sanitizeChatMessageContent(m.content),
        sources: m.sources,
        widgets: m.widgets,
        selectionContext: m.selectionContext,
      }));
      const updated = await this.chatRepo.createMessages(
        created.id,
        formattedMessages,
        dto.documentIds,
      );
      const result = formatChat(updated);
      await this.invalidateChatCache(userId, created.id, cleanProjectId);
      return result;
    }

    const result = formatChat(created);
    await this.invalidateChatCache(userId, created.id, cleanProjectId);
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

    const formattedMessages = dto.messages.map((m: any) => ({
      role: validateAndSanitizeRole(m.role),
      content: sanitizeChatMessageContent(m.content),
      sources: m.sources,
      widgets: m.widgets,
      selectionContext: m.selectionContext,
    }));

    if (formattedMessages.some((m) => !m.content || !m.content.trim())) {
      throw new UnprocessableEntityException('Message content cannot be empty');
    }

    const updated = await this.chatRepo.createMessages(
      chatId,
      formattedMessages,
      dto.documentIds,
    );
    const result = formatChat(updated);

    await this.invalidateChatCache(chat.userId, chatId, chat.projectId);

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

    await this.invalidateChatCache(chat.userId, chatId, chat.projectId);

    return result;
  }

  async deleteChat(chatId: string, userId: string) {
    const chat = await this.chatRepo.findChatByIdAndUser(chatId, userId);
    if (!chat) {
      throw new NotFoundException('Chat not found');
    }
    await this.chatRepo.deleteChat(chatId);

    await this.invalidateChatCache(chat.userId, chatId, chat.projectId);

    return { success: true };
  }

  async clearMemory(userId: string, scopeId?: string) {
    const targetProject =
      scopeId && scopeId !== 'clear' && scopeId !== userId ? scopeId : null;
    await this.chatRepo.clearUserChats(userId, targetProject);
    await this.invalidateChatCache(userId, undefined, targetProject);
    return { success: true };
  }
}

// Backward compatibility aliases
export const ThreadService = ChatService;
export type ThreadService = ChatService;
