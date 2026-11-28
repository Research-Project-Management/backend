import {
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { ChatService } from '@/modules/project/chat/services/chat.service';
import {
  ConversationType,
  ConversationMemberRole,
  MessageType,
} from '@prisma/client';

describe('ChatService Unit Tests', () => {
  let service: ChatService;
  let mockPrisma: any;
  let mockChatCache: any;

  beforeEach(() => {
    mockPrisma = {
      conversation: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
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
      user: {
        findUnique: jest.fn(),
      },
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

    mockChatCache = {
      getRecentMessages: jest.fn(),
      pushMessage: jest.fn(),
      cacheMessage: jest.fn(),
      invalidate: jest.fn(),
    };

    service = new ChatService(mockPrisma, mockChatCache);
  });

  describe('verifyConversationAccess', () => {
    it('throws NotFoundException when conversation is not found', async () => {
      mockPrisma.conversation.findUnique.mockResolvedValue(null);

      await expect(
        service.verifyConversationAccess('conv-404', 'user-1'),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws ForbiddenException when user is not member of a direct or group conversation', async () => {
      mockPrisma.conversation.findUnique.mockResolvedValue({
        id: 'conv-direct',
        type: ConversationType.direct,
        members: [], // User not among members
      });

      await expect(
        service.verifyConversationAccess('conv-direct', 'user-outsider'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('grants access when user is a member of direct conversation', async () => {
      const conv = {
        id: 'conv-direct',
        type: ConversationType.direct,
        members: [{ userId: 'user-1' }],
      };
      mockPrisma.conversation.findUnique.mockResolvedValue(conv);

      const res = await service.verifyConversationAccess(
        'conv-direct',
        'user-1',
      );
      expect(res.id).toBe('conv-direct');
    });

    it('throws ForbiddenException when user is not in the project for a project_channel', async () => {
      mockPrisma.conversation.findUnique.mockResolvedValue({
        id: 'conv-chan',
        type: ConversationType.project_channel,
        members: [],
        project: {
          createdById: 'project-owner',
          members: [], // user-outsider is not in project members
        },
      });

      await expect(
        service.verifyConversationAccess('conv-chan', 'user-outsider'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('grants access and auto-provisions channel member record if project member enters channel for the first time', async () => {
      const conv = {
        id: 'conv-chan',
        type: ConversationType.project_channel,
        members: [], // no conversationMember record yet
        project: {
          createdById: 'project-owner',
          members: [{ userId: 'user-researcher', role: 'contributor' }],
        },
      };
      mockPrisma.conversation.findUnique.mockResolvedValue(conv);
      mockPrisma.conversationMember.create.mockResolvedValue({
        conversationId: 'conv-chan',
        userId: 'user-researcher',
      });

      const res = await service.verifyConversationAccess(
        'conv-chan',
        'user-researcher',
      );
      expect(res.id).toBe('conv-chan');
      expect(mockPrisma.conversationMember.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            conversationId: 'conv-chan',
            userId: 'user-researcher',
          }),
        }),
      );
    });
  });

  describe('getOrCreateDirect', () => {
    it('throws BadRequestException if user tries to chat with themselves', async () => {
      await expect(
        service.getOrCreateDirect('user-self', 'user-self'),
      ).rejects.toThrow(BadRequestException);
    });

    it('returns existing direct conversation if found', async () => {
      const existingConv = {
        id: 'conv-existing',
        type: ConversationType.direct,
        members: [{ userId: 'u1' }, { userId: 'u2' }],
      };
      mockPrisma.conversation.findFirst.mockResolvedValue(existingConv);

      const res = await service.getOrCreateDirect('u1', 'u2');
      expect(res.id).toBe('conv-existing');
      expect(mockPrisma.conversation.create).not.toHaveBeenCalled();
    });

    it('creates new direct conversation if none exists', async () => {
      mockPrisma.conversation.findFirst.mockResolvedValue(null);
      mockPrisma.conversation.create.mockImplementation(
        ({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({ id: 'conv-new', ...data }),
      );

      const res = await service.getOrCreateDirect('u1', 'u2');
      expect(res.id).toBe('conv-new');
      expect(mockPrisma.conversation.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            type: ConversationType.direct,
            createdById: 'u1',
          }),
        }),
      );
    });
  });

  describe('sendMessage', () => {
    it('throws BadRequestException when message content is blank and no attachments', async () => {
      await expect(
        service.sendMessage('conv-1', 'user-1', { content: '   ' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('persists message to cold storage and updates conversation lastMessageAt', async () => {
      // Mock access check
      mockPrisma.conversation.findUnique.mockResolvedValue({
        id: 'conv-1',
        type: ConversationType.direct,
        members: [{ userId: 'user-1' }],
      });

      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'alice@flux.dev',
        profile: { name: 'Alice', avatar: null },
      });

      const fakeSavedMessage = {
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
      };
      mockPrisma.message.create.mockResolvedValue(fakeSavedMessage);
      mockPrisma.conversation.update.mockResolvedValue({ id: 'conv-1' });

      const msg = await service.sendMessage('conv-1', 'user-1', {
        content: 'Hello, team!',
      });

      expect(msg.content).toBe('Hello, team!');
      expect(mockPrisma.message.create).toHaveBeenCalled();
      expect(mockPrisma.conversation.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'conv-1' },
          data: expect.objectContaining({
            lastMessageAt: expect.any(Date),
            lastMessageSnippet: 'Hello, team!',
          }),
        }),
      );
      expect(mockChatCache.pushMessage).toHaveBeenCalled();
    });
  });

  describe('getConversationMemberIds', () => {
    it('returns empty array when conversation is not found', async () => {
      mockPrisma.conversation.findUnique.mockResolvedValue(null);
      await expect(
        service.getConversationMemberIds('conv-missing'),
      ).resolves.toEqual([]);
    });

    it('returns direct and group conversation member IDs', async () => {
      mockPrisma.conversation.findUnique.mockResolvedValue({
        type: ConversationType.group,
        members: [{ userId: 'u-1' }, { userId: 'u-2' }, { userId: 'u-1' }],
        project: null,
      });

      const ids = await service.getConversationMemberIds('conv-group');
      expect(ids).toEqual(['u-1', 'u-2']);
    });

    it('unions conversation members, project creator, and project members for project_channel', async () => {
      mockPrisma.conversation.findUnique.mockResolvedValue({
        type: ConversationType.project_channel,
        members: [{ userId: 'u-1' }],
        project: {
          createdById: 'owner-1',
          members: [{ userId: 'u-2' }, { userId: 'u-1' }],
        },
      });

      const ids = await service.getConversationMemberIds('conv-proj');
      expect(ids).toEqual(expect.arrayContaining(['u-1', 'owner-1', 'u-2']));
      expect(ids).toHaveLength(3);
    });
  });

  describe('markAsRead & removeReaction security', () => {
    it('markAsRead throws ForbiddenException for non-members and updates lastReadAt for valid members', async () => {
      mockPrisma.conversation.findUnique.mockResolvedValueOnce({
        id: 'conv-1',
        type: ConversationType.direct,
        members: [],
      });

      await expect(service.markAsRead('conv-1', 'outsider')).rejects.toThrow(
        ForbiddenException,
      );
      expect(mockPrisma.conversationMember.updateMany).not.toHaveBeenCalled();

      mockPrisma.conversation.findUnique.mockResolvedValueOnce({
        id: 'conv-1',
        type: ConversationType.direct,
        members: [{ userId: 'member-1' }],
      });
      mockPrisma.conversationMember.updateMany.mockResolvedValueOnce({
        count: 1,
      });

      const res = await service.markAsRead('conv-1', 'member-1');
      expect(res.success).toBe(true);
      expect(typeof res.lastReadAt).toBe('string');
      expect(mockPrisma.conversationMember.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { conversationId: 'conv-1', userId: 'member-1' },
        }),
      );
    });

    it('removeReaction throws ForbiddenException for non-members and deletes + invalidates cache for valid members', async () => {
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
        service.removeReaction('msg-1', 'outsider', '👍'),
      ).rejects.toThrow(ForbiddenException);
      expect(mockPrisma.messageReaction.deleteMany).not.toHaveBeenCalled();

      mockPrisma.conversation.findUnique.mockResolvedValueOnce({
        id: 'conv-1',
        type: ConversationType.direct,
        members: [{ userId: 'member-1' }],
      });
      mockPrisma.messageReaction.deleteMany.mockResolvedValueOnce({ count: 1 });

      const res = await service.removeReaction('msg-1', 'member-1', '👍');
      expect(res).toEqual({ success: true, conversationId: 'conv-1' });
      expect(mockPrisma.messageReaction.deleteMany).toHaveBeenCalledWith({
        where: { messageId: 'msg-1', userId: 'member-1', emoji: '👍' },
      });
      expect(mockChatCache.invalidate).toHaveBeenCalledWith('conv-1');
    });
  });
});
