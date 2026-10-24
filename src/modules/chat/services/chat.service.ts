import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '@/core/infrastructure/database/prisma.service';
import { ChatCacheService, CachedMessage } from './chat-cache.service';
import {
  ConversationType,
  ConversationMemberRole,
  MessageType,
  Prisma,
} from '@prisma/client';

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly chatCache: ChatCacheService,
  ) {}

  /**
   * Get all conversations accessible to the user (Direct, Group, and Project Channels).
   */
  async getUserConversations(userId: string) {
    // 1. Fetch Direct/Group memberships and User Projects in parallel
    const [standardMemberships, userProjects] = await Promise.all([
      this.prisma.conversationMember.findMany({
        where: {
          userId,
          conversation: {
            type: { in: [ConversationType.direct, ConversationType.group] },
          },
        },
        include: {
          conversation: {
            include: {
              members: {
                include: {
                  user: {
                    select: {
                      id: true,
                      email: true,
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
          },
        },
        orderBy: { conversation: { lastMessageAt: 'desc' } },
      }),
      this.prisma.project.findMany({
        where: {
          OR: [{ createdById: userId }, { members: { some: { userId } } }],
        },
        select: { id: true, name: true, identifier: true },
      }),
    ]);

    const projectIds = userProjects.map((p) => p.id);
    const projectMap = new Map(userProjects.map((p) => [p.id, p]));

    const projectChannels =
      projectIds.length > 0
        ? await this.prisma.conversation.findMany({
            where: {
              projectId: { in: projectIds },
              type: ConversationType.project_channel,
            },
            include: {
              members: {
                where: { userId },
              },
            },
            orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
          })
        : [];

    // 2. Fast-path unread count resolution:
    // Only query conversations where lastMessageAt > lastReadAt (eliminates N+1 queries for read/empty chats)
    const unreadThresholds = new Map<string, Date>();

    for (const m of standardMemberships) {
      const conv = m.conversation;
      const lastReadAt = m.lastReadAt || new Date(0);
      if (conv.lastMessageAt && conv.lastMessageAt > lastReadAt) {
        unreadThresholds.set(conv.id, lastReadAt);
      }
    }

    for (const ch of projectChannels) {
      const membership = ch.members[0];
      const lastReadAt = membership?.lastReadAt || new Date(0);
      if (ch.lastMessageAt && ch.lastMessageAt > lastReadAt) {
        unreadThresholds.set(ch.id, lastReadAt);
      }
    }

    const unreadCountMap = new Map<string, number>();

    if (unreadThresholds.size > 0) {
      const candidateIds = Array.from(unreadThresholds.keys());
      let minLastReadAt = new Date();
      for (const dt of unreadThresholds.values()) {
        if (dt < minLastReadAt) minLastReadAt = dt;
      }

      const candidateMessages = await this.prisma.message.findMany({
        where: {
          conversationId: { in: candidateIds },
          senderId: { not: userId },
          isDeleted: false,
          createdAt: { gt: minLastReadAt },
        },
        select: {
          conversationId: true,
          createdAt: true,
        },
      });

      for (const msg of candidateMessages) {
        const threshold = unreadThresholds.get(msg.conversationId);
        if (threshold && msg.createdAt > threshold) {
          unreadCountMap.set(
            msg.conversationId,
            (unreadCountMap.get(msg.conversationId) || 0) + 1,
          );
        }
      }
    }

    // 3. Format results synchronously in memory (0 additional DB queries)
    const formattedStandard = standardMemberships.map((m) => {
      const conv = m.conversation;
      const unreadCount = unreadCountMap.get(conv.id) || 0;

      let title = conv.name;
      let avatar = conv.avatar;
      let otherUser = null;

      if (conv.type === ConversationType.direct) {
        const otherMember = conv.members.find((mem) => mem.userId !== userId);
        if (otherMember) {
          const profile = otherMember.user.profile;
          title = profile?.name || otherMember.user.email.split('@')[0];
          avatar = profile?.avatar || null;
          otherUser = {
            id: otherMember.user.id,
            email: otherMember.user.email,
            name: title,
            avatar,
          };
        }
      }

      return {
        id: conv.id,
        type: conv.type,
        name: title || 'Conversation',
        topic: conv.topic,
        avatar,
        projectId: conv.projectId,
        isDefault: conv.isDefault,
        otherUser,
        memberCount: conv.members.length,
        lastMessageAt: conv.lastMessageAt,
        lastMessageSnippet: conv.lastMessageSnippet,
        lastSenderName: conv.lastSenderName,
        unreadCount,
        isMuted: m.isMuted,
        isPinned: m.isPinned,
        updatedAt: conv.updatedAt,
      };
    });

    const formattedChannels = projectChannels.map((ch) => {
      const membership = ch.members[0];
      const unreadCount = unreadCountMap.get(ch.id) || 0;
      const proj = ch.projectId ? projectMap.get(ch.projectId) : null;

      return {
        id: ch.id,
        type: ch.type,
        name: ch.name || 'general',
        topic: ch.topic,
        avatar: ch.avatar,
        projectId: ch.projectId,
        projectName: proj?.name || 'Project',
        projectIdentifier: proj?.identifier || '',
        isDefault: ch.isDefault,
        otherUser: null,
        memberCount: 0,
        lastMessageAt: ch.lastMessageAt,
        lastMessageSnippet: ch.lastMessageSnippet,
        lastSenderName: ch.lastSenderName,
        unreadCount,
        isMuted: membership?.isMuted || false,
        isPinned: membership?.isPinned || false,
        updatedAt: ch.updatedAt,
      };
    });

    return {
      directs: formattedStandard.filter(
        (c) => c.type === ConversationType.direct,
      ),
      groups: formattedStandard.filter(
        (c) => c.type === ConversationType.group,
      ),
      projectChannels: formattedChannels,
    };
  }

  /**
   * Get or create a direct 1-1 conversation between two users.
   */
  async getOrCreateDirect(userId1: string, userId2: string) {
    if (userId1 === userId2) {
      throw new BadRequestException(
        'Cannot create direct conversation with yourself',
      );
    }

    const existing = await this.prisma.conversation.findFirst({
      where: {
        type: ConversationType.direct,
        AND: [
          { members: { some: { userId: userId1 } } },
          { members: { some: { userId: userId2 } } },
        ],
      },
      include: {
        members: {
          include: {
            user: {
              select: {
                id: true,
                email: true,
                profile: { select: { name: true, avatar: true } },
              },
            },
          },
        },
      },
    });

    if (existing) {
      return existing;
    }

    return this.prisma.conversation.create({
      data: {
        type: ConversationType.direct,
        createdById: userId1,
        members: {
          create: [
            { userId: userId1, role: ConversationMemberRole.member },
            { userId: userId2, role: ConversationMemberRole.member },
          ],
        },
      },
      include: {
        members: {
          include: {
            user: {
              select: {
                id: true,
                email: true,
                profile: { select: { name: true, avatar: true } },
              },
            },
          },
        },
      },
    });
  }

  /**
   * Create a custom group conversation.
   */
  async createGroup(
    userId: string,
    dto: { name: string; avatar?: string; memberIds?: string[] },
  ) {
    const cleanName = dto.name.trim();
    if (!cleanName) {
      throw new BadRequestException('Group name is required');
    }

    const memberSet = new Set<string>([userId]);
    if (dto.memberIds && Array.isArray(dto.memberIds)) {
      dto.memberIds.forEach((id) => memberSet.add(id));
    }

    return this.prisma.conversation.create({
      data: {
        type: ConversationType.group,
        name: cleanName,
        avatar: dto.avatar || null,
        createdById: userId,
        members: {
          create: Array.from(memberSet).map((uId) => ({
            userId: uId,
            role:
              uId === userId
                ? ConversationMemberRole.owner
                : ConversationMemberRole.member,
          })),
        },
      },
      include: {
        members: {
          include: {
            user: {
              select: {
                id: true,
                email: true,
                profile: { select: { name: true, avatar: true } },
              },
            },
          },
        },
      },
    });
  }

  /**
   * Verify if user has permission to view and send messages in a conversation.
   */
  async verifyConversationAccess(conversationId: string, userId: string) {
    const conv = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      include: {
        members: { where: { userId } },
        project: {
          include: {
            members: { where: { userId } },
          },
        },
      },
    });

    if (!conv) {
      throw new NotFoundException('Conversation not found');
    }

    // Direct / Group check
    if (conv.type !== ConversationType.project_channel) {
      if (conv.members.length === 0) {
        throw new ForbiddenException(
          'You are not a member of this conversation',
        );
      }
      return conv;
    }

    // Project Channel check
    const isProjectOwner = conv.project?.createdById === userId;
    const isProjectMember = (conv.project?.members.length || 0) > 0;

    if (!isProjectOwner && !isProjectMember) {
      throw new ForbiddenException(
        'You do not have access to this project channel',
      );
    }

    // Ensure member record exists for lastRead tracking
    if (conv.members.length === 0) {
      await this.prisma.conversationMember.create({
        data: {
          conversationId,
          userId,
          role: isProjectOwner
            ? ConversationMemberRole.owner
            : ConversationMemberRole.member,
        },
      });
    }

    return conv;
  }

  async verifyConversationMember(conversationId: string, userId: string) {
    return this.verifyConversationAccess(conversationId, userId);
  }

  /**
   * Get messages with 2-tier architecture (Hot Cache Redis RAM -> Cold Storage PostgreSQL).
   * Cursor-based pagination on cold storage.
   */
  async getMessages(
    conversationId: string,
    userId: string,
    cursor?: string,
    limit = 25,
  ): Promise<{ messages: CachedMessage[]; nextCursor: string | null }> {
    await this.verifyConversationAccess(conversationId, userId);

    const boundedLimit = Math.min(Math.max(1, limit), 50);

    // 1. Hot cache check: If no cursor is specified (initial load), try Redis first
    if (!cursor) {
      const cached = await this.chatCache.getRecentMessages(
        conversationId,
        boundedLimit,
      );
      if (cached && cached.length > 0) {
        const nextCursor =
          cached.length >= boundedLimit
            ? cached[cached.length - 1].createdAt
            : null;
        return {
          messages: cached,
          nextCursor,
        };
      }
    }

    // 2. Cold storage read from PostgreSQL
    const where: Prisma.MessageWhereInput = {
      conversationId,
      isDeleted: false,
    };

    if (cursor) {
      where.createdAt = {
        lt: new Date(cursor),
      };
    }

    const messages = await this.prisma.message.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: boundedLimit,
      include: {
        sender: {
          select: {
            id: true,
            email: true,
            profile: {
              select: {
                name: true,
                avatar: true,
              },
            },
          },
        },
        reactions: {
          select: {
            id: true,
            userId: true,
            emoji: true,
          },
        },
        replyTo: {
          select: {
            id: true,
            content: true,
            sender: {
              select: {
                profile: {
                  select: { name: true },
                },
              },
            },
          },
        },
      },
    });

    const formatted: CachedMessage[] = messages.map((m) => ({
      id: m.id,
      conversationId: m.conversationId,
      senderId: m.senderId,
      type: m.type,
      content: m.content,
      attachments: m.attachments,
      replyToId: m.replyToId,
      replyTo: m.replyTo
        ? {
            id: m.replyTo.id,
            content: m.replyTo.content,
            sender: {
              name: m.replyTo.sender.profile?.name || null,
            },
          }
        : null,
      isEdited: m.isEdited,
      isDeleted: m.isDeleted,
      createdAt: m.createdAt.toISOString(),
      updatedAt: m.updatedAt.toISOString(),
      sender: {
        id: m.sender.id,
        email: m.sender.email,
        name: m.sender.profile?.name || m.sender.email.split('@')[0],
        avatar: m.sender.profile?.avatar || null,
      },
      reactions: m.reactions,
    }));

    // If initial load missed cache, backfill Redis RAM asynchronously
    if (!cursor && formatted.length > 0) {
      this.chatCache
        .cacheRecentMessages(conversationId, formatted)
        .catch((err) => {
          this.logger.warn(`Failed to backfill chat cache: ${err.message}`);
        });
    }

    const nextCursor =
      formatted.length >= boundedLimit
        ? formatted[formatted.length - 1].createdAt
        : null;

    return {
      messages: formatted,
      nextCursor,
    };
  }

  /**
   * Send a new message: Persists in DB, pushes to Redis hot cache, updates conversation snippet.
   */
  async sendMessage(
    conversationId: string,
    senderId: string,
    dto: {
      content: string;
      type?: MessageType;
      attachments?: unknown[];
      replyToId?: string;
    },
  ): Promise<CachedMessage> {
    const cleanContent = dto.content.trim();
    if (!cleanContent && (!dto.attachments || dto.attachments.length === 0)) {
      throw new BadRequestException('Message cannot be empty');
    }

    await this.verifyConversationAccess(conversationId, senderId);

    // Fetch sender profile for metadata
    const sender = await this.prisma.user.findUnique({
      where: { id: senderId },
      select: {
        id: true,
        email: true,
        profile: { select: { name: true, avatar: true } },
      },
    });

    const senderName =
      sender?.profile?.name || sender?.email.split('@')[0] || 'User';

    // 1. Cold storage insertion
    const msg = await this.prisma.message.create({
      data: {
        conversationId,
        senderId,
        type: dto.type || MessageType.text,
        content: cleanContent,
        attachments: (dto.attachments as Prisma.InputJsonValue) || [],
        replyToId: dto.replyToId || null,
      },
      include: {
        reactions: true,
        replyTo: {
          select: {
            id: true,
            content: true,
            sender: {
              select: { profile: { select: { name: true } } },
            },
          },
        },
      },
    });

    // 2. Update conversation snippet for super fast conversation list loading
    const snippet = cleanContent.slice(0, 150);
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: {
        lastMessageAt: msg.createdAt,
        lastMessageSnippet: snippet,
        lastSenderName: senderName,
      },
    });

    // Update sender's lastReadAt
    await this.prisma.conversationMember.updateMany({
      where: { conversationId, userId: senderId },
      data: { lastReadAt: msg.createdAt },
    });

    const cached: CachedMessage = {
      id: msg.id,
      conversationId: msg.conversationId,
      senderId: msg.senderId,
      type: msg.type,
      content: msg.content,
      attachments: msg.attachments,
      replyToId: msg.replyToId,
      replyTo: msg.replyTo
        ? {
            id: msg.replyTo.id,
            content: msg.replyTo.content,
            sender: {
              name: msg.replyTo.sender.profile?.name || null,
            },
          }
        : null,
      isEdited: msg.isEdited,
      isDeleted: msg.isDeleted,
      createdAt: msg.createdAt.toISOString(),
      updatedAt: msg.updatedAt.toISOString(),
      sender: {
        id: senderId,
        email: sender?.email,
        name: senderName,
        avatar: sender?.profile?.avatar || null,
      },
      reactions: [],
    };

    // 3. Hot cache push to Redis RAM
    await this.chatCache.pushMessage(conversationId, cached);

    return cached;
  }

  /**
   * Mark conversation as read for the user.
   */
  async markAsRead(conversationId: string, userId: string) {
    const now = new Date();
    await this.prisma.conversationMember.updateMany({
      where: { conversationId, userId },
      data: { lastReadAt: now },
    });
    return { success: true, lastReadAt: now.toISOString() };
  }

  /**
   * Add reaction emoji to a message.
   */
  async addReaction(messageId: string, userId: string, emoji: string) {
    const msg = await this.prisma.message.findUnique({
      where: { id: messageId },
    });

    if (!msg) {
      throw new NotFoundException('Message not found');
    }

    await this.verifyConversationAccess(msg.conversationId, userId);

    const reaction = await this.prisma.messageReaction.upsert({
      where: {
        messageId_userId_emoji: {
          messageId,
          userId,
          emoji,
        },
      },
      update: {},
      create: {
        messageId,
        userId,
        emoji,
      },
    });

    // Invalidate conversation cache so reactions refresh
    await this.chatCache.invalidate(msg.conversationId);

    return { reaction, conversationId: msg.conversationId };
  }

  /**
   * Remove reaction emoji from a message.
   */
  async removeReaction(messageId: string, userId: string, emoji: string) {
    const msg = await this.prisma.message.findUnique({
      where: { id: messageId },
    });

    if (!msg) {
      throw new NotFoundException('Message not found');
    }

    await this.prisma.messageReaction.deleteMany({
      where: {
        messageId,
        userId,
        emoji,
      },
    });

    await this.chatCache.invalidate(msg.conversationId);

    return { success: true, conversationId: msg.conversationId };
  }
}
