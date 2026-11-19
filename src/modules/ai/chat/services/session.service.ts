import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { getErrorMessage, RedisCacheService } from '@/core';
import { AI_ENGINE_PORT, AI_REDIS_KEYS } from '../../ai.constant';
import { SpaceAccessService } from '../../access/services/space.service';
import type { IAiEnginePort } from '../../engine/engine.port';
import { ChatRepository } from '../chat.repository';
import {
  formatChatSession,
  sanitizeMessageContent,
  sanitizeMessageRole,
} from '../domain/session.mapper';
import { sanitizeChatTitle } from '../domain/title.domain';
import type {
  AppendMessagesDto,
  CreateSessionDto,
  RenameSessionDto,
} from '../dto/session.dto';
import type { FormattedChatSession } from '../types/chat.type';

@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);

  constructor(
    private readonly chatRepo: ChatRepository,
    private readonly spaceAccess: SpaceAccessService,
    @Optional() private readonly cache?: RedisCacheService,
    @Optional()
    @Inject(AI_ENGINE_PORT)
    private readonly engine?: IAiEnginePort,
  ) {}

  private async invalidateCache(
    userId: string,
    chatId?: string,
    spaceId?: string | null,
  ): Promise<void> {
    if (!this.cache) return;
    const keys: Promise<unknown>[] = [
      this.cache.del(AI_REDIS_KEYS.userChats(userId, spaceId)),
      this.cache.del(AI_REDIS_KEYS.userChats(userId, null)),
    ];
    if (chatId) {
      keys.push(this.cache.del(AI_REDIS_KEYS.chatSession(chatId)));
      keys.push(
        this.cache.del(`${AI_REDIS_KEYS.chatSession(chatId)}:${userId}`),
      );
    }
    await Promise.all(keys).catch((err: unknown) => {
      this.logger.warn(
        `Failed to invalidate AI session cache: ${getErrorMessage(err)}`,
      );
    });
  }

  async getChats(
    userId: string,
    rawSpaceId?: string | null,
  ): Promise<FormattedChatSession[]> {
    const scope = await this.spaceAccess.resolveSpace(userId, rawSpaceId);
    const cacheKey = AI_REDIS_KEYS.userChats(userId, scope.spaceId);

    if (this.cache) {
      const cached = await this.cache.get<FormattedChatSession[]>(cacheKey);
      if (cached) return cached;
    }

    const rows = await this.chatRepo.findUserChats(userId, scope.spaceId);
    const result = rows.map(formatChatSession);

    if (this.cache) {
      await this.cache.set(cacheKey, result, 1800);
    }
    return result;
  }

  async getChat(chatId: string, userId: string): Promise<FormattedChatSession> {
    const cacheKey = `${AI_REDIS_KEYS.chatSession(chatId)}:${userId}`;
    if (this.cache) {
      const cached = await this.cache.get<FormattedChatSession>(cacheKey);
      if (cached) return cached;
    }

    const row = await this.chatRepo.findChatByIdAndUser(chatId, userId);
    if (!row) {
      throw new NotFoundException('Chat not found');
    }

    const formatted = formatChatSession(row);
    if (this.cache) {
      await this.cache.set(cacheKey, formatted, 1800);
    }
    return formatted;
  }

  async createChat(
    userId: string,
    dto: CreateSessionDto,
  ): Promise<FormattedChatSession> {
    let scope = await this.spaceAccess.resolveSpace(userId, dto.spaceId);
    let canonicalPageId = dto.pageId;

    if (dto.pageId) {
      const pageMeta = await this.spaceAccess.resolvePageScope(
        userId,
        dto.pageId,
        dto.spaceId,
      );
      canonicalPageId = pageMeta.canonicalPageId;
      scope = {
        spaceId: pageMeta.spaceId,
        projectId: pageMeta.projectId,
      };
    }

    const created = await this.chatRepo.createChat({
      createdById: userId,
      spaceId: scope.spaceId,
      pageId: canonicalPageId,
      title: sanitizeChatTitle(dto.title),
      documentIds: dto.documentIds,
    });

    if (dto.messages && dto.messages.length > 0) {
      const normalized = dto.messages.map((m) => ({
        role: sanitizeMessageRole(m.role),
        content: sanitizeMessageContent(m.content),
        sources: (m.attachments || m.sources) as
          Prisma.InputJsonValue | undefined,
        widgets: m.widgets as Prisma.InputJsonValue | undefined,
        selectionContext: m.selectionContext as
          Prisma.InputJsonValue | undefined,
      }));
      const updated = await this.chatRepo.createMessages(
        created.id,
        normalized,
        dto.documentIds,
      );
      if (!updated) {
        throw new NotFoundException('Chat not found');
      }
      await this.invalidateCache(userId, created.id, scope.spaceId);
      return formatChatSession(updated);
    }

    await this.invalidateCache(userId, created.id, scope.spaceId);
    return formatChatSession(created);
  }

  async getPageChat(pageId: string, userId: string) {
    if (!pageId) {
      throw new BadRequestException('pageId is required');
    }
    const pageMeta = await this.spaceAccess.resolvePageScope(userId, pageId);
    const row = await this.chatRepo.findPageChat(
      pageMeta.canonicalPageId,
      userId,
    );
    const formatted = row ? formatChatSession(row) : null;
    return {
      chat: formatted,
      messages: formatted?.messages || [],
    };
  }

  async getOrCreatePageChat(
    pageId: string,
    userId: string,
    rawSpaceId?: string | null,
  ): Promise<FormattedChatSession> {
    if (!pageId) {
      throw new BadRequestException('pageId is required');
    }
    const pageMeta = await this.spaceAccess.resolvePageScope(
      userId,
      pageId,
      rawSpaceId,
    );
    const existing = await this.chatRepo.findPageChat(
      pageMeta.canonicalPageId,
      userId,
    );
    if (existing) {
      return formatChatSession(existing);
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

    await this.invalidateCache(userId, created.id, pageMeta.spaceId);
    return formatChatSession(created);
  }

  async clearPageChat(pageId: string, userId: string) {
    if (!pageId) {
      throw new BadRequestException('pageId is required');
    }
    const pageMeta = await this.spaceAccess.resolvePageScope(userId, pageId);
    const result = await this.chatRepo.deletePageChat(
      pageMeta.canonicalPageId,
      userId,
    );

    if (result.chatIds.length > 0) {
      const engine = this.engine;
      await Promise.all([
        ...(engine
          ? result.chatIds.map((id) =>
              engine.deleteThread(pageMeta.spaceId, id).catch(() => undefined),
            )
          : []),
        ...result.chatIds.map((id) =>
          this.invalidateCache(userId, id, pageMeta.spaceId),
        ),
      ]);
    } else {
      await this.invalidateCache(userId, undefined, pageMeta.spaceId);
    }
    return { success: true };
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

    const formatted = dto.messages.map((m) => ({
      role: sanitizeMessageRole(m.role),
      content: sanitizeMessageContent(m.content),
      sources: (m.attachments || m.sources) as
        Prisma.InputJsonValue | undefined,
      widgets: m.widgets as Prisma.InputJsonValue | undefined,
      selectionContext: m.selectionContext as Prisma.InputJsonValue | undefined,
    }));

    if (formatted.some((m) => !m.content || !m.content.trim())) {
      throw new UnprocessableEntityException('Message content cannot be empty');
    }

    const updated = await this.chatRepo.createMessages(
      chatId,
      formatted,
      dto.documentIds,
    );
    if (!updated) {
      throw new NotFoundException('Chat not found');
    }

    await this.invalidateCache(chat.createdById, chatId, chat.spaceId);
    return formatChatSession(updated);
  }

  async renameChat(
    chatId: string,
    userId: string,
    dto: RenameSessionDto,
  ): Promise<FormattedChatSession> {
    const chat = await this.chatRepo.findChatByIdAndUser(chatId, userId);
    if (!chat) {
      throw new NotFoundException('Chat not found');
    }

    const updated = await this.chatRepo.updateChatTitle(
      chatId,
      sanitizeChatTitle(dto.title),
    );
    await this.invalidateCache(chat.createdById, chatId, chat.spaceId);
    return formatChatSession(updated);
  }

  async deleteChat(chatId: string, userId: string) {
    const chat = await this.chatRepo.findChatByIdAndUser(chatId, userId);
    if (!chat) {
      throw new NotFoundException('Chat not found');
    }

    await this.chatRepo.deleteChat(chatId);
    await this.engine
      ?.deleteThread(chat.spaceId, chatId)
      .catch(() => undefined);
    await this.invalidateCache(chat.createdById, chatId, chat.spaceId);
    return { success: true };
  }

  async clearMemory(userId: string, spaceId?: string) {
    const rawTarget =
      spaceId && spaceId !== 'clear' && spaceId !== userId ? spaceId : null;
    const scope = await this.spaceAccess.resolveSpace(userId, rawTarget);
    const deleted = await this.chatRepo.clearUserChats(userId, scope.spaceId);

    const engine = this.engine;
    if (scope.projectId === null && engine) {
      await engine.deleteSpaceThreads(scope.spaceId).catch(() => undefined);
    } else if (engine && deleted.chatIds.length > 0) {
      await Promise.all(
        deleted.chatIds.map((id) =>
          engine.deleteThread(scope.spaceId, id).catch(() => undefined),
        ),
      );
    }

    await this.invalidateCache(userId, undefined, scope.spaceId);
    return { success: true };
  }
}
