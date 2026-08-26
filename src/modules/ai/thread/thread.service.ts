import {
  Injectable,
  NotFoundException,
  BadRequestException,
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
import { RedisCacheService } from '@/core/cache/redis-cache.service';
import { AI_REDIS_KEYS } from './constants/redis-keys.constant';

export interface FormattedChatSession {
  _id: string;
  id: string;
  title: string;
  projectId?: string | null;
  pageId?: string | null;
  workspaceSlug: string;
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
    _id: chat.id,
    id: chat.id,
    title: chat.title,
    projectId: chat.projectId,
    pageId: chat.pageId,
    workspaceSlug: chat.workspaceSlug,
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
    @Optional() private readonly cache?: RedisCacheService,
  ) {}

  private async invalidateThreadCache(
    userId: string,
    workspaceSlug: string,
    chatId?: string,
    projectId?: string | null,
  ) {
    if (!this.cache) return;
    const promises: Promise<any>[] = [
      this.cache.del(AI_REDIS_KEYS.userChats(workspaceSlug, userId, projectId)),
      this.cache.del(AI_REDIS_KEYS.userChats(workspaceSlug, userId, null)),
    ];
    if (chatId) {
      promises.push(this.cache.del(AI_REDIS_KEYS.chatThread(chatId)));
    }
    await Promise.all(promises).catch((err) => {
      this.logger.warn(`Failed to invalidate AI thread cache: ${err}`);
    });
  }

  async getChats(
    workspaceId: string,
    userId: string,
    projectId?: string | null,
  ): Promise<FormattedChatSession[]> {
    if (!workspaceId) {
      throw new BadRequestException('workspaceId is required');
    }

    const cacheKey = AI_REDIS_KEYS.userChats(workspaceId, userId, projectId);
    if (this.cache) {
      const cached = await this.cache.get<FormattedChatSession[]>(cacheKey);
      if (cached) return cached;
    }

    const rawChats = await this.threadRepo.findUserChats(
      workspaceId,
      userId,
      projectId,
    );
    const result = rawChats.map(formatChat);

    if (this.cache) {
      await this.cache.set(cacheKey, result, 1800);
    }

    return result;
  }

  async getPageChat(pageId: string, workspaceId: string, userId: string) {
    if (!pageId || !workspaceId) {
      throw new BadRequestException('pageId and workspaceId are required');
    }
    const raw = await this.threadRepo.findPageChat(pageId, workspaceId, userId);
    return {
      chat: raw ? formatChat(raw) : null,
      messages: raw?.messages || [],
    };
  }

  async clearPageChat(pageId: string, workspaceId: string, userId: string) {
    if (!pageId || !workspaceId) {
      throw new BadRequestException('pageId and workspaceId are required');
    }
    await this.threadRepo.deletePageChat(pageId, workspaceId, userId);
    await this.invalidateThreadCache(userId, workspaceId);
    return { success: true };
  }

  async getChat(chatId: string): Promise<FormattedChatSession> {
    const cacheKey = AI_REDIS_KEYS.chatThread(chatId);
    if (this.cache) {
      const cached = await this.cache.get<FormattedChatSession>(cacheKey);
      if (cached) return cached;
    }

    const raw = await this.threadRepo.findChatById(chatId);
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
    const workspaceSlug = dto.workspaceSlug || dto.workspaceId;
    if (!workspaceSlug) {
      throw new BadRequestException('workspaceSlug or workspaceId is required');
    }

    const created = await this.threadRepo.createChat({
      userId,
      workspaceSlug,
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
        workspaceSlug,
        created.id,
        dto.projectId,
      );
      return result;
    }

    const result = formatChat(created);
    await this.invalidateThreadCache(
      userId,
      workspaceSlug,
      created.id,
      dto.projectId,
    );
    return result;
  }

  async appendMessages(
    chatId: string,
    dto: AppendMessagesDto,
  ): Promise<FormattedChatSession> {
    const chat = await this.threadRepo.findChatById(chatId);
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
      chat.workspaceSlug,
      chatId,
      chat.projectId,
    );

    return result;
  }

  async renameChat(
    chatId: string,
    dto: RenameThreadDto,
  ): Promise<FormattedChatSession> {
    const chat = await this.threadRepo.findChatById(chatId);
    if (!chat) {
      throw new NotFoundException('Chat not found');
    }

    const updated = await this.threadRepo.updateChatTitle(chatId, dto.title);
    const result = formatChat(updated);

    await this.invalidateThreadCache(
      chat.userId,
      chat.workspaceSlug,
      chatId,
      chat.projectId,
    );

    return result;
  }

  async deleteChat(chatId: string) {
    const chat = await this.threadRepo.findChatById(chatId);
    await this.threadRepo.deleteChat(chatId);

    if (chat) {
      await this.invalidateThreadCache(
        chat.userId,
        chat.workspaceSlug,
        chatId,
        chat.projectId,
      );
    }

    return { success: true };
  }

  async clearMemory(workspaceId: string, userId: string) {
    await this.threadRepo.clearUserWorkspaceChats(workspaceId, userId);
    await this.invalidateThreadCache(userId, workspaceId);
    return { success: true };
  }
}
