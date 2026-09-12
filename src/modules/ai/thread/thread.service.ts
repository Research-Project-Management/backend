import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Optional,
  Logger,
} from '@nestjs/common';
import { ThreadRepository } from './thread.repository';
import {
  CreateThreadDto,
  AppendMessagesDto,
  RenameThreadDto,
} from './dto/thread.dto';
import { MessageRole } from '@prisma/client';
import { RedisCacheService } from '@/core/cache/redis.service';
import { AI_REDIS_KEYS } from './constants/redis-keys.constant';
import { PrismaService } from '@/core/database/prisma.service';

export interface FormattedChatSession {
  id: string;
  title: string;
  projectId?: string | null;
  pageId?: string | null;
  scopeSlug?: string;
  messageCount: number;
  lastMessage: string;
  documentIds: string[];
  createdAt: string;
  updatedAt: string;
  messages?: Array<{
    id: string;
    role: string;
    content: string;
    sources?: unknown;
    widgets?: unknown;
    createdAt: string;
  }>;
}

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
export class ThreadService {
  private readonly logger = new Logger(ThreadService.name);

  constructor(
    private readonly threadRepo: ThreadRepository,
    private readonly prisma: PrismaService,
    @Optional() private readonly cache?: RedisCacheService,
  ) {}

  private async invalidateThreadCache(
    userId: string,
    chatId?: string,
    projectId?: string | null,
  ) {
    if (!this.cache) return;
    const scopeId = projectId || userId;
    const promises: Promise<any>[] = [
      this.cache.del(AI_REDIS_KEYS.userChats(scopeId, userId, projectId)),
      this.cache.del(AI_REDIS_KEYS.userChats(userId, userId, null)),
    ];
    if (chatId) {
      promises.push(this.cache.del(AI_REDIS_KEYS.chatThread(chatId)));
      promises.push(
        this.cache.del(`${AI_REDIS_KEYS.chatThread(chatId)}:${userId}`),
      );
    }
    await Promise.all(promises).catch((err) => {
      this.logger.warn(`Failed to invalidate AI thread cache: ${err}`);
    });
  }

  async getChats(
    userId: string,
    projectId?: string | null,
  ): Promise<FormattedChatSession[]> {
    if (projectId) {
      const project = await this.prisma.project.findFirst({
        where: {
          id: projectId,
          deletedAt: null,
          OR: [
            { createdById: userId },
            { members: { some: { userId } } },
          ],
        },
        select: { id: true },
      });
      if (!project) {
        throw new ForbiddenException('User does not have access to this project');
      }
    }

    const scopeId = projectId || userId;
    const cacheKey = AI_REDIS_KEYS.userChats(scopeId, userId, projectId);
    if (this.cache) {
      const cached = await this.cache.get<FormattedChatSession[]>(cacheKey);
      if (cached) return cached;
    }

    const rawChats = await this.threadRepo.findUserChats(
      userId,
      projectId,
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
    const raw = await this.threadRepo.findPageChat(pageId, userId);
    return {
      chat: raw ? formatChat(raw) : null,
      messages: raw?.messages || [],
    };
  }

  async clearPageChat(pageId: string, userId: string) {
    if (!pageId) {
      throw new BadRequestException('pageId is required');
    }
    await this.threadRepo.deletePageChat(pageId, userId);
    await this.invalidateThreadCache(userId);
    return { success: true };
  }

  async getChat(chatId: string, userId: string): Promise<FormattedChatSession> {
    const cacheKey = `${AI_REDIS_KEYS.chatThread(chatId)}:${userId}`;
    if (this.cache) {
      const cached = await this.cache.get<FormattedChatSession>(cacheKey);
      if (cached) return cached;
    }

    const raw = await this.threadRepo.findChatByIdAndUser(chatId, userId);
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
    dto: CreateThreadDto,
  ): Promise<FormattedChatSession> {
    // Verify project access if specified
    if (dto.projectId) {
      const project = await this.prisma.project.findFirst({
        where: {
          id: dto.projectId,
          deletedAt: null,
          OR: [
            { createdById: userId },
            { members: { some: { userId } } },
          ],
        },
        select: { id: true, identifier: true },
      });
      if (!project) {
        throw new ForbiddenException('User does not have access to this project');
      }
    }

    // Verify page access if specified
    if (dto.pageId) {
      const page = await this.prisma.page.findFirst({
        where: { id: dto.pageId, deletedAt: null },
        include: {
          project: {
            select: {
              id: true,
              identifier: true,
              createdById: true,
              members: { where: { userId }, select: { userId: true } },
            },
          },
        },
      });
      if (!page) {
        throw new NotFoundException('Page not found');
      }
      const canAccess =
        page.authorId === userId ||
        page.project?.createdById === userId ||
        (page.project?.members && page.project.members.length > 0);
      if (!canAccess) {
        throw new ForbiddenException('User does not have access to this page');
      }
      if (!dto.projectId && page.projectId) {
        dto.projectId = page.projectId;
      }
    }

    const created = await this.threadRepo.createChat({
      userId,
      projectId: dto.projectId,
      pageId: dto.pageId,
      title: dto.title,
      documentIds: dto.documentIds,
    });

    if (dto.messages && dto.messages.length > 0) {
      const formattedMessages = dto.messages.map((m: any) => ({
        role: (m.role as MessageRole) || MessageRole.user,
        content: m.content || '',
        sources: m.sources,
        widgets: m.widgets,
        selectionContext: m.selectionContext,
      }));
      const updated = await this.threadRepo.createMessages(
        created.id,
        formattedMessages,
        dto.documentIds,
      );
      const result = formatChat(updated);
      await this.invalidateThreadCache(
        userId,
        created.id,
        dto.projectId,
      );
      return result;
    }

    const result = formatChat(created);
    await this.invalidateThreadCache(
      userId,
      created.id,
      dto.projectId,
    );
    return result;
  }

  async appendMessages(
    chatId: string,
    userId: string,
    dto: AppendMessagesDto,
  ): Promise<FormattedChatSession> {
    const chat = await this.threadRepo.findChatByIdAndUser(chatId, userId);
    if (!chat) {
      throw new NotFoundException('Chat not found');
    }

    const formattedMessages = dto.messages.map((m: any) => ({
      role: (m.role as MessageRole) || MessageRole.user,
      content: m.content || '',
      sources: m.sources,
      widgets: m.widgets,
      selectionContext: m.selectionContext,
    }));

    const updated = await this.threadRepo.createMessages(
      chatId,
      formattedMessages,
      dto.documentIds,
    );
    const result = formatChat(updated);

    await this.invalidateThreadCache(
      chat.userId,
      chatId,
      chat.projectId,
    );

    return result;
  }

  async renameChat(
    chatId: string,
    userId: string,
    dto: RenameThreadDto,
  ): Promise<FormattedChatSession> {
    const chat = await this.threadRepo.findChatByIdAndUser(chatId, userId);
    if (!chat) {
      throw new NotFoundException('Chat not found');
    }

    const updated = await this.threadRepo.updateChatTitle(chatId, dto.title);
    const result = formatChat(updated);

    await this.invalidateThreadCache(
      chat.userId,
      chatId,
      chat.projectId,
    );

    return result;
  }

  async deleteChat(chatId: string, userId: string) {
    const chat = await this.threadRepo.findChatByIdAndUser(chatId, userId);
    if (!chat) {
      throw new NotFoundException('Chat not found');
    }
    await this.threadRepo.deleteChat(chatId);

    await this.invalidateThreadCache(
      chat.userId,
      chatId,
      chat.projectId,
    );

    return { success: true };
  }

  async clearMemory(userId: string, scopeId?: string) {
    const targetProject = scopeId && scopeId !== 'clear' && scopeId !== userId ? scopeId : null;
    await this.threadRepo.clearUserChats(userId, targetProject);
    await this.invalidateThreadCache(userId, undefined, targetProject);
    return { success: true };
  }
}
