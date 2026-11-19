import {
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { ProjectChannelService } from '@/modules/chat/services/project-channel.service';
import { ConversationType, ConversationMemberRole } from '@prisma/client';

describe('ProjectChannelService Unit Tests', () => {
  let service: ProjectChannelService;
  let mockPrisma: any;

  beforeEach(() => {
    mockPrisma = {
      project: {
        findUnique: jest.fn(),
      },
      conversation: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        delete: jest.fn(),
      },
      conversationMember: {
        upsert: jest.fn(),
      },
    };

    service = new ProjectChannelService(mockPrisma);
  });

  describe('checkProjectAccess', () => {
    it('throws NotFoundException if project does not exist', async () => {
      mockPrisma.project.findUnique.mockResolvedValue(null);

      await expect(
        service.checkProjectAccess('proj-non-existent', 'user-1'),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws ForbiddenException if user is neither owner nor member', async () => {
      mockPrisma.project.findUnique.mockResolvedValue({
        id: 'proj-1',
        createdById: 'owner-id',
        members: [],
      });

      await expect(
        service.checkProjectAccess('proj-1', 'outsider-user'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('allows project creator/owner', async () => {
      mockPrisma.project.findUnique.mockResolvedValue({
        id: 'proj-1',
        createdById: 'user-owner',
        members: [],
      });

      const hasAccess = await service.checkProjectAccess(
        'proj-1',
        'user-owner',
      );
      expect(hasAccess).toBe(true);
    });

    it('allows project member', async () => {
      mockPrisma.project.findUnique.mockResolvedValue({
        id: 'proj-1',
        createdById: 'user-owner',
        members: [{ userId: 'user-member', role: 'contributor' }],
      });

      const hasAccess = await service.checkProjectAccess(
        'proj-1',
        'user-member',
      );
      expect(hasAccess).toBe(true);
    });
  });

  describe('checkProjectAdmin', () => {
    it('allows project creator', async () => {
      mockPrisma.project.findUnique.mockResolvedValue({
        id: 'proj-1',
        createdById: 'user-owner',
        members: [],
      });

      const isAdmin = await service.checkProjectAdmin('proj-1', 'user-owner');
      expect(isAdmin).toBe(true);
    });

    it('allows coordinator member', async () => {
      mockPrisma.project.findUnique.mockResolvedValue({
        id: 'proj-1',
        createdById: 'user-owner',
        members: [{ userId: 'user-coord', role: 'coordinator' }],
      });

      const isAdmin = await service.checkProjectAdmin('proj-1', 'user-coord');
      expect(isAdmin).toBe(true);
    });

    it('denies regular member from admin actions', async () => {
      mockPrisma.project.findUnique.mockResolvedValue({
        id: 'proj-1',
        createdById: 'user-owner',
        members: [{ userId: 'user-regular', role: 'contributor' }],
      });

      await expect(
        service.checkProjectAdmin('proj-1', 'user-regular'),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('getProjectChannels auto-provisioning', () => {
    it('returns existing channels with enriched metadata', async () => {
      mockPrisma.project.findUnique.mockResolvedValue({
        id: 'proj-1',
        name: 'Quantum ML',
        identifier: 'QML',
        createdById: 'user-1',
        members: [{ userId: 'user-1' }],
      });

      const fakeChannels = [
        {
          id: 'chan-1',
          name: 'general',
          type: ConversationType.project_channel,
          topic: 'General chat',
          avatar: null,
          projectId: 'proj-1',
          isDefault: true,
          members: [{ isMuted: false, isPinned: true }],
          _count: { members: 3 },
          updatedAt: new Date('2026-01-01'),
        },
      ];

      mockPrisma.conversation.findMany.mockResolvedValue(fakeChannels);

      const result = await service.getProjectChannels('proj-1', 'user-1');

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('general');
      expect(result[0].isDefault).toBe(true);
      expect(result[0].isPinned).toBe(true);
      expect(result[0].memberCount).toBe(3);
      expect(result[0].projectName).toBe('Quantum ML');
    });

    it('auto-provisions #general channel when no channels exist', async () => {
      // First findUnique for checkProjectAccess
      mockPrisma.project.findUnique.mockResolvedValueOnce({
        id: 'proj-1',
        createdById: 'user-owner',
        members: [{ userId: 'user-member-1' }, { userId: 'user-member-2' }],
      });

      // findMany returns empty array (no channels)
      mockPrisma.conversation.findMany.mockResolvedValue([]);

      // Second findUnique to fetch project members for auto-provisioning
      mockPrisma.project.findUnique.mockResolvedValueOnce({
        id: 'proj-1',
        createdById: 'user-owner',
        members: [{ userId: 'user-member-1' }, { userId: 'user-member-2' }],
      });

      const createdGeneral = {
        id: 'chan-new-gen',
        name: 'general',
        type: ConversationType.project_channel,
        topic: 'General project discussions and coordination',
        projectId: 'proj-1',
        isDefault: true,
        createdById: 'user-owner',
        members: [{ isMuted: false, isPinned: false }],
        _count: { members: 3 },
        updatedAt: new Date(),
      };
      mockPrisma.conversation.create.mockResolvedValue(createdGeneral);

      // Third findUnique for project name/identifier lookup
      mockPrisma.project.findUnique.mockResolvedValueOnce({
        name: 'Project Alpha',
        identifier: 'PAL',
      });

      const result = await service.getProjectChannels('proj-1', 'user-owner');

      expect(mockPrisma.conversation.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            name: 'general',
            isDefault: true,
            projectId: 'proj-1',
          }),
        }),
      );
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('general');
    });
  });

  describe('createChannel', () => {
    it('normalizes channel name by trimming, lowercasing, and replacing spaces with dashes', async () => {
      mockPrisma.project.findUnique.mockResolvedValue({
        id: 'proj-1',
        createdById: 'user-owner',
        members: [{ userId: 'user-1' }],
      });

      mockPrisma.conversation.findFirst.mockResolvedValue(null);
      mockPrisma.conversation.create.mockImplementation(({ data }) =>
        Promise.resolve({ id: 'c-new', ...data }),
      );

      const res = await service.createChannel('proj-1', 'user-owner', {
        name: ' #Experiment Results 2026 ',
        topic: 'Data benchmarks',
      });

      expect(res.name).toBe('experiment-results-2026');
      expect(res.isDefault).toBe(false);
    });

    it('rejects duplicate channel names in the same project', async () => {
      mockPrisma.project.findUnique.mockResolvedValue({
        id: 'proj-1',
        createdById: 'user-owner',
        members: [],
      });

      mockPrisma.conversation.findFirst.mockResolvedValue({
        id: 'c-existing',
        name: 'benchmarks',
      });

      await expect(
        service.createChannel('proj-1', 'user-owner', { name: 'benchmarks' }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('deleteChannel', () => {
    it('prevents deleting the default #general channel', async () => {
      mockPrisma.project.findUnique.mockResolvedValue({
        id: 'proj-1',
        createdById: 'user-owner',
        members: [],
      });

      mockPrisma.conversation.findUnique.mockResolvedValue({
        id: 'c-gen',
        projectId: 'proj-1',
        isDefault: true,
      });

      await expect(
        service.deleteChannel('proj-1', 'c-gen', 'user-owner'),
      ).rejects.toThrow(BadRequestException);
    });

    it('deletes custom channel successfully', async () => {
      mockPrisma.project.findUnique.mockResolvedValue({
        id: 'proj-1',
        createdById: 'user-owner',
        members: [],
      });

      mockPrisma.conversation.findUnique.mockResolvedValue({
        id: 'c-custom',
        projectId: 'proj-1',
        isDefault: false,
      });

      mockPrisma.conversation.delete.mockResolvedValue({ id: 'c-custom' });

      const res = await service.deleteChannel(
        'proj-1',
        'c-custom',
        'user-owner',
      );
      expect(res).toEqual({ success: true });
      expect(mockPrisma.conversation.delete).toHaveBeenCalledWith({
        where: { id: 'c-custom' },
      });
    });
  });
});
