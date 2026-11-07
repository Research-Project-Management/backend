import { Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '@/core/infrastructure/database/prisma.service';
import { RedisCacheService } from '@/core/infrastructure/redis/redis.service';
import { ChatMessage } from './types/presence.type';
import { ProjectChatSendDto } from './dto/events.dto';
import * as crypto from 'crypto';

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);
  private readonly projectChatStore = new Map<string, ChatMessage[]>();
  private static readonly MAX_CHAT_HISTORY = 200;
  private static readonly MAX_PROJECT_CHATS = 500;

  constructor(
    @Optional() private readonly prisma?: PrismaService,
    @Optional() private readonly redis?: RedisCacheService,
  ) {}

  private cacheKey(projectId: string): string {
    return `manuscript:chat:${projectId}`;
  }

  private addMessageToMemoryStore(
    projectId: string,
    message: ChatMessage,
  ): void {
    let history = this.projectChatStore.get(projectId);
    if (history) {
      // Refresh LRU order
      this.projectChatStore.delete(projectId);
    } else {
      history = [];
      if (this.projectChatStore.size >= ChatService.MAX_PROJECT_CHATS) {
        const oldestKey = this.projectChatStore.keys().next().value;
        if (oldestKey !== undefined) {
          this.projectChatStore.delete(oldestKey);
        }
      }
    }
    this.projectChatStore.set(projectId, history);
    history.push(message);

    if (history.length > ChatService.MAX_CHAT_HISTORY) {
      history.splice(0, history.length - ChatService.MAX_CHAT_HISTORY);
    }
  }

  public saveMessage(
    dto: ProjectChatSendDto,
    user: { id: string; name: string; color?: string; avatar?: string },
  ): ChatMessage {
    const message: ChatMessage = {
      id: crypto.randomUUID(),
      projectId: dto.projectId,
      userId: user.id,
      userName: user.name,
      userColor: user.color,
      userAvatar: user.avatar,
      text: dto.text,
      replyToId: dto.replyToId,
      createdAt: new Date().toISOString(),
    };

    // 1. Instant in-memory cache update
    this.addMessageToMemoryStore(dto.projectId, message);
    const currentHistory = this.projectChatStore.get(dto.projectId) ?? [message];

    // 2. Asynchronous cache & Prisma persistence
    void this.persistMessageAsync(dto, user, message, currentHistory);

    return message;
  }

  private async persistMessageAsync(
    dto: ProjectChatSendDto,
    user: { id: string; name: string; color?: string; avatar?: string },
    message: ChatMessage,
    currentHistory: ChatMessage[],
  ): Promise<void> {
    // Write-through to Redis cache
    if (this.redis) {
      try {
        await this.redis.set(
          this.cacheKey(dto.projectId),
          currentHistory,
          3600,
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.debug(`Redis chat cache update notice: ${msg}`);
      }
    }

    // Persist to Prisma Conversation & Message models
    if (this.prisma) {
      try {
        let conversation = await this.prisma.conversation.findFirst({
          where: {
            projectId: dto.projectId,
            type: 'project_channel',
          },
        });

        const userRecord = await this.prisma.user
          .findUnique({
            where: { id: user.id },
            select: { id: true },
          })
          .catch(() => null);

        if (!userRecord) {
          this.logger.warn(
            `Skipping Prisma persistence for chat message ${message.id}: sender ${user.id} not found`,
          );
          return;
        }

        if (!conversation) {
          conversation = await this.prisma.conversation.create({
            data: {
              type: 'project_channel',
              projectId: dto.projectId,
              name: 'general',
              topic: 'Realtime manuscript discussion channel',
              createdById: user.id,
              isDefault: true,
              lastMessageAt: new Date(message.createdAt),
              lastMessageSnippet: dto.text.slice(0, 100),
              lastSenderName: user.name,
            },
          });
        }

        if (this.prisma.conversationMember?.upsert) {
          await this.prisma.conversationMember
            .upsert({
              where: {
                conversationId_userId: {
                  conversationId: conversation.id,
                  userId: user.id,
                },
              },
              create: {
                conversationId: conversation.id,
                userId: user.id,
                role: 'member',
              },
              update: {},
            })
            .catch(() => undefined);
        }

        await this.prisma.message.create({
          data: {
            id: message.id,
            conversationId: conversation.id,
            senderId: user.id,
            type: 'text',
            content: dto.text,
            replyToId: dto.replyToId ?? null,
            createdAt: new Date(message.createdAt),
          },
        });

        await this.prisma.conversation.update({
          where: { id: conversation.id },
          data: {
            lastMessageAt: new Date(message.createdAt),
            lastMessageSnippet: dto.text.slice(0, 100),
            lastSenderName: user.name,
          },
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `Failed to persist chat message to Prisma database: ${msg}`,
        );
      }
    }
  }

  public getHistory(projectId: string): ChatMessage[] {
    const inMemoryHistory = this.projectChatStore.get(projectId);
    if (inMemoryHistory && inMemoryHistory.length > 0) {
      return [...inMemoryHistory];
    }

    // Trigger background cache-aside hydration if in-memory is empty
    void this.hydrateHistoryAsync(projectId);

    return inMemoryHistory ? [...inMemoryHistory] : [];
  }

  public async getHistoryAsync(projectId: string): Promise<ChatMessage[]> {
    const inMemoryHistory = this.projectChatStore.get(projectId);
    if (inMemoryHistory && inMemoryHistory.length > 0) {
      return [...inMemoryHistory];
    }

    return await this.hydrateHistoryAsync(projectId);
  }

  private async hydrateHistoryAsync(projectId: string): Promise<ChatMessage[]> {
    // 1. Check Redis cache
    if (this.redis) {
      try {
        const cached = await this.redis.get<ChatMessage[]>(
          this.cacheKey(projectId),
        );
        if (cached && Array.isArray(cached) && cached.length > 0) {
          this.projectChatStore.set(projectId, cached);
          return cached;
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.debug(`Redis chat cache read notice: ${msg}`);
      }
    }

    // 2. Query Prisma Conversation & Message models
    if (this.prisma) {
      try {
        const conversation = await this.prisma.conversation.findFirst({
          where: {
            projectId,
            type: 'project_channel',
          },
          include: {
            messages: {
              where: { isDeleted: false },
              orderBy: { createdAt: 'desc' },
              take: ChatService.MAX_CHAT_HISTORY,
              include: {
                sender: {
                  include: {
                    profile: {
                      select: {
                        name: true,
                        avatar: true,
                      },
                    },
                  },
                },
              },
            },
          },
        });

        if (conversation && conversation.messages.length > 0) {
          const mapped: ChatMessage[] = conversation.messages
            .reverse()
            .map((msg) => ({
              id: msg.id,
              projectId,
              userId: msg.senderId,
              userName: msg.sender?.profile?.name || 'Collaborator',
              userAvatar: msg.sender?.profile?.avatar || undefined,
              text: msg.content,
              replyToId: msg.replyToId ?? undefined,
              createdAt: msg.createdAt.toISOString(),
            }));

          this.projectChatStore.set(projectId, mapped);
          if (this.redis) {
            await this.redis
              .set(this.cacheKey(projectId), mapped, 3600)
              .catch(() => {});
          }
          return mapped;
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.debug(
          `Prisma chat history query notice for project ${projectId}: ${msg}`,
        );
      }
    }

    return [];
  }
}
