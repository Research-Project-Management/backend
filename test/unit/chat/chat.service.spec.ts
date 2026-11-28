import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ConversationType, MessageType } from '@prisma/client';
import { fromPartial } from '@total-typescript/shoehorn';
import type { PrismaService } from '@/core/infrastructure/database/prisma.service';
import { ChatCacheService } from '@/modules/project/chat/services/chat-cache.service';
import { ChatService } from '@/modules/project/chat/services/chat.service';
import { ProjectChannelService } from '@/modules/project/chat/services/project-channel.service';

describe('ChatService & ProjectChannelService Unit Tests', () => {
  let chatService: ChatService;
  let channelService: ProjectChannelService;
  let mockPrisma: {
    conversation: {
      findUnique: jest.Mock;
      findFirst: jest.Mock;
      findMany: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
    };
    conversationMember: {
      findMany: jest.Mock;
      findUnique: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
      upsert: jest.Mock;
    };
    project: {
      findMany: jest.Mock;
      findUnique: jest.Mock;
    };
    user: { findUnique: jest.Mock };
    message: {
      findUnique: jest.Mock;
      findMany: jest.Mock;
      create: jest.Mock;
      count: jest.Mock;
    };
    messageReaction: {
      upsert: jest.Mock;
      deleteMany: jest.Mock;
    };
  };
  let mockChatCache: jest.Mocked<ChatCacheService>;

  beforeEach(() => {
    mockPrisma = {
      conversation: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
      conversationMember: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
        upsert: jest.fn(),
      },
      project: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
      },
      user: { findUnique: jest.fn() },
      message: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        count: jest.fn(),
      },
      messageReaction: {
        upsert: jest.fn(),
        deleteMany: jest.fn(),
      },
    };

    mockChatCache = fromPartial<jest.Mocked<ChatCacheService>>({
      getRecentMessages: jest.fn(),
      pushMessage: jest.fn(),
      invalidate: jest.fn(),
    });

    const prismaService = fromPartial<PrismaService>(mockPrisma);
    chatService = new ChatService(prismaService, mockChatCache);
    channelService = new ProjectChannelService(prismaService);
  });

  describe('ChatService - Access, Direct Conversations, Messaging & Reactions', () => {
    it('verifies conversation membership across direct/group/project_channel and auto-provisions first-time project channel members', async () => {
      mockPrisma.conversation.findUnique.mockResolvedValueOnce(null);
      await expect(
        chatService.verifyConversationAccess('conv-404', 'user-1'),
      ).rejects.toThrow(NotFoundException);

      mockPrisma.conversation.findUnique.mockResolvedValueOnce({
        id: 'conv-direct',
        type: ConversationType.direct,
        members: [],
      });
      await expect(
        chatService.verifyConversationAccess('conv-direct', 'user-outsider'),
      ).rejects.toThrow(ForbiddenException);

      mockPrisma.conversation.findUnique.mockResolvedValueOnce({
        id: 'conv-direct',
        type: ConversationType.direct,
        members: [{ userId: 'user-1' }],
      });
      await expect(
        chatService.verifyConversationAccess('conv-direct', 'user-1'),
      ).resolves.toMatchObject({ id: 'conv-direct' });

      mockPrisma.conversation.findUnique.mockResolvedValueOnce({
        id: 'conv-chan',
        type: ConversationType.project_channel,
        members: [],
        project: { createdById: 'project-owner', members: [] },
      });
      await expect(
        chatService.verifyConversationAccess('conv-chan', 'user-outsider'),
      ).rejects.toThrow(ForbiddenException);

      mockPrisma.conversation.findUnique.mockResolvedValueOnce({
        id: 'conv-chan',
        type: ConversationType.project_channel,
        members: [],
        project: {
          createdById: 'project-owner',
          members: [{ userId: 'user-researcher', role: 'contributor' }],
        },
      });
      mockPrisma.conversationMember.create.mockResolvedValueOnce({
        conversationId: 'conv-chan',
        userId: 'user-researcher',
      });

      const joined = await chatService.verifyConversationAccess(
        'conv-chan',
        'user-researcher',
      );
      expect(joined.id).toBe('conv-chan');
      expect(mockPrisma.conversationMember.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            conversationId: 'conv-chan',
            userId: 'user-researcher',
          }),
        }),
      );
    });

    it('manages direct chats, persists messages, computes unioned member IDs, and guards markAsRead + removeReaction', async () => {
      await expect(
        chatService.getOrCreateDirect('user-self', 'user-self'),
      ).rejects.toThrow(BadRequestException);

      mockPrisma.conversation.findFirst.mockResolvedValueOnce({
        id: 'conv-existing',
        type: ConversationType.direct,
        members: [{ userId: 'u1' }, { userId: 'u2' }],
      });
      await expect(
        chatService.getOrCreateDirect('u1', 'u2'),
      ).resolves.toMatchObject({ id: 'conv-existing' });

      mockPrisma.conversation.findFirst.mockResolvedValueOnce(null);
      mockPrisma.conversation.create.mockImplementationOnce(
        async ({ data }: { data: Record<string, unknown> }) => ({
          id: 'conv-new',
          ...data,
        }),
      );
      await expect(
        chatService.getOrCreateDirect('u1', 'u2'),
      ).resolves.toMatchObject({ id: 'conv-new' });

      // sendMessage
      await expect(
        chatService.sendMessage('conv-1', 'user-1', { content: '   ' }),
      ).rejects.toThrow(BadRequestException);

      mockPrisma.conversation.findUnique.mockResolvedValueOnce({
        id: 'conv-1',
        type: ConversationType.direct,
        members: [{ userId: 'user-1' }],
      });
      mockPrisma.user.findUnique.mockResolvedValueOnce({
        id: 'user-1',
        email: 'alice@flux.dev',
        profile: { name: 'Alice', avatar: null },
      });
      mockPrisma.message.create.mockResolvedValueOnce({
        id: 'msg-1',
        conversationId: 'conv-1',
        senderId: 'user-1',
        content: 'Hello, team!',
        type: MessageType.text,
        attachments: [],
        createdAt: new Date(),
        updatedAt: new Date(),
        sender: {
          id: 'user-1',
          email: 'alice@flux.dev',
          profile: { name: 'Alice', avatar: null },
        },
        reactions: [],
      });
      mockPrisma.conversation.update.mockResolvedValueOnce({ id: 'conv-1' });

      const sent = await chatService.sendMessage('conv-1', 'user-1', {
        content: 'Hello, team!',
      });
      expect(sent.content).toBe('Hello, team!');
      expect(mockChatCache.pushMessage).toHaveBeenCalled();

      // getConversationMemberIds
      mockPrisma.conversation.findUnique.mockResolvedValueOnce(null);
      await expect(
        chatService.getConversationMemberIds('missing'),
      ).resolves.toEqual([]);

      mockPrisma.conversation.findUnique.mockResolvedValueOnce({
        type: ConversationType.project_channel,
        members: [{ userId: 'u-1' }],
        project: {
          createdById: 'owner-1',
          members: [{ userId: 'u-2' }, { userId: 'u-1' }],
        },
      });
      const ids = await chatService.getConversationMemberIds('conv-proj');
      expect(ids).toHaveLength(3);
      expect(ids).toEqual(expect.arrayContaining(['u-1', 'owner-1', 'u-2']));

      // markAsRead & removeReaction membership enforcement
      mockPrisma.conversation.findUnique.mockResolvedValueOnce({
        id: 'conv-1',
        type: ConversationType.direct,
        members: [],
      });
      await expect(chatService.markAsRead('conv-1', 'outsider')).rejects.toThrow(
        ForbiddenException,
      );

      mockPrisma.conversation.findUnique.mockResolvedValueOnce({
        id: 'conv-1',
        type: ConversationType.direct,
        members: [{ userId: 'member-1' }],
      });
      mockPrisma.conversationMember.updateMany.mockResolvedValueOnce({ count: 1 });
      await expect(
        chatService.markAsRead('conv-1', 'member-1'),
      ).resolves.toMatchObject({ success: true });

      mockPrisma.message.findUnique.mockResolvedValue({
        id: 'msg-1',
        conversationId: 'conv-1',
      });
      mockPrisma.conversation.findUnique.mockResolvedValueOnce({
        id: 'conv-1',
        type: ConversationType.direct,
        members: [],
      });
      await expect(
        chatService.removeReaction('msg-1', 'outsider', '👍'),
      ).rejects.toThrow(ForbiddenException);

      mockPrisma.conversation.findUnique.mockResolvedValueOnce({
        id: 'conv-1',
        type: ConversationType.direct,
        members: [{ userId: 'member-1' }],
      });
      mockPrisma.messageReaction.deleteMany.mockResolvedValueOnce({ count: 1 });
      await expect(
        chatService.removeReaction('msg-1', 'member-1', '👍'),
      ).resolves.toEqual({ success: true, conversationId: 'conv-1' });
      expect(mockChatCache.invalidate).toHaveBeenCalledWith('conv-1');
    });
  });

  describe('ProjectChannelService - Access, Auto-Provisioning & Channel Lifecycle', () => {
    it('enforces project member/admin permissions, auto-provisions #general, normalizes slugs, and protects #general from deletion', async () => {
      mockPrisma.project.findUnique.mockResolvedValueOnce(null);
      await expect(
        channelService.checkProjectAccess('proj-missing', 'user-1'),
      ).rejects.toThrow(NotFoundException);

      mockPrisma.project.findUnique.mockResolvedValueOnce({
        id: 'proj-1',
        createdById: 'owner-id',
        members: [],
      });
      await expect(
        channelService.checkProjectAccess('proj-1', 'outsider'),
      ).rejects.toThrow(ForbiddenException);

      mockPrisma.project.findUnique.mockResolvedValueOnce({
        id: 'proj-1',
        createdById: 'owner-id',
        members: [{ userId: 'user-coord', role: 'coordinator' }],
      });
      await expect(
        channelService.checkProjectAdmin('proj-1', 'user-coord'),
      ).resolves.toBe(true);

      mockPrisma.project.findUnique.mockResolvedValueOnce({
        id: 'proj-1',
        createdById: 'owner-id',
        members: [{ userId: 'user-regular', role: 'contributor' }],
      });
      await expect(
        channelService.checkProjectAdmin('proj-1', 'user-regular'),
      ).rejects.toThrow(ForbiddenException);

      // Auto-provision #general when empty
      mockPrisma.project.findUnique
        .mockResolvedValueOnce({
          id: 'proj-1',
          createdById: 'user-owner',
          members: [{ userId: 'user-member-1' }],
        })
        .mockResolvedValueOnce({
          id: 'proj-1',
          createdById: 'user-owner',
          members: [{ userId: 'user-member-1' }],
        })
        .mockResolvedValueOnce({
          name: 'Project Alpha',
          identifier: 'PAL',
        });
      mockPrisma.conversation.findMany.mockResolvedValueOnce([]);
      mockPrisma.conversation.create.mockResolvedValueOnce({
        id: 'chan-new-gen',
        name: 'general',
        type: ConversationType.project_channel,
        topic: 'General project discussions and coordination',
        projectId: 'proj-1',
        isDefault: true,
        createdById: 'user-owner',
        members: [{ isMuted: false, isPinned: false }],
        _count: { members: 2 },
        updatedAt: new Date(),
      });

      const provisioned = await channelService.getProjectChannels(
        'proj-1',
        'user-owner',
      );
      expect(provisioned).toHaveLength(1);
      expect(provisioned[0]).toMatchObject({
        name: 'general',
        isDefault: true,
        projectName: 'Project Alpha',
      });

      // Slug normalization + duplicate check
      mockPrisma.project.findUnique.mockResolvedValue({
        id: 'proj-1',
        createdById: 'user-owner',
        members: [{ userId: 'user-1' }],
      });
      mockPrisma.conversation.findFirst.mockResolvedValueOnce(null);
      mockPrisma.conversation.create.mockImplementationOnce(
        async ({ data }: { data: Record<string, unknown> }) => ({
          id: 'c-new',
          ...data,
        }),
      );

      const created = await channelService.createChannel(
        'proj-1',
        'user-owner',
        { name: ' #Experiment Results 2026 ', topic: 'Data benchmarks' },
      );
      expect(created.name).toBe('experiment-results-2026');
      expect(created.isDefault).toBe(false);

      mockPrisma.conversation.findFirst.mockResolvedValueOnce({
        id: 'c-existing',
        name: 'benchmarks',
      });
      await expect(
        channelService.createChannel('proj-1', 'user-owner', {
          name: 'benchmarks',
        }),
      ).rejects.toThrow(BadRequestException);

      // Protect default #general from deletion, allow custom channel deletion
      mockPrisma.conversation.findUnique.mockResolvedValueOnce({
        id: 'c-gen',
        projectId: 'proj-1',
        isDefault: true,
      });
      await expect(
        channelService.deleteChannel('proj-1', 'c-gen', 'user-owner'),
      ).rejects.toThrow(BadRequestException);

      mockPrisma.conversation.findUnique.mockResolvedValueOnce({
        id: 'c-custom',
        projectId: 'proj-1',
        isDefault: false,
      });
      mockPrisma.conversation.delete.mockResolvedValueOnce({ id: 'c-custom' });
      await expect(
        channelService.deleteChannel('proj-1', 'c-custom', 'user-owner'),
      ).resolves.toEqual({ success: true });
    });
  });
});
