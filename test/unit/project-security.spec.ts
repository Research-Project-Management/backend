import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ProjectMemberRole, InvitationStatus } from '@prisma/client';
import { InvitationService } from '@/modules/project/invitation/invitation.service';
import { CoreRepository } from '@/modules/project/core/core.repository';
import {
  CoreService,
  sanitizeModules,
  ALLOWED_PROJECT_MODULES,
} from '@/modules/project/core/core.service';
import { MemberService } from '@/modules/project/member/member.service';
import { deriveProjectPrefix } from '@/modules/project/core/utils/identifier.util';

describe('Project Module Security & SSOT Suite', () => {
  describe('InvitationService - Zero-Trust & Anti-BOLA in joinByCode', () => {
    let invitationService: InvitationService;
    let mockRepo: any;
    let mockCache: any;

    const mockUser = {
      id: 'd3b07384-d113-4678-831e-4eeea6608930',
      email: 'researcher@flux.ac.vn',
      role: 'user',
    };

    beforeEach(() => {
      mockRepo = {
        findByTokenHash: jest.fn().mockResolvedValue(null),
        findProjectByIdOrIdentifier: jest.fn(),
        findMember: jest.fn().mockResolvedValue(null),
        findPendingByProjectAndEmail: jest.fn().mockResolvedValue(null),
        addProjectMember: jest.fn().mockResolvedValue({}),
        updateStatus: jest.fn().mockResolvedValue({}),
        findUserById: jest.fn(),
        findUserByEmail: jest.fn(),
        create: jest.fn(),
      };
      mockCache = {
        del: jest.fn().mockResolvedValue(1),
      };

      invitationService = new InvitationService(mockRepo, mockCache);
    });

    it('should reject joinByCode when no invitation token is provided and no pending invite exists (Anti-BOLA)', async () => {
      mockRepo.findProjectByIdOrIdentifier.mockResolvedValue({
        id: 'proj-private-uuid',
        name: 'Private Cancer Research',
        identifier: 'PCR',
        isActive: true,
      });

      await expect(
        invitationService.joinByCode('PCR', mockUser as any),
      ).rejects.toThrow(ForbiddenException);

      expect(mockRepo.addProjectMember).not.toHaveBeenCalled();
    });

    it('should accept pending invitation when joining by project identifier if pending invite exists for user email', async () => {
      mockRepo.findProjectByIdOrIdentifier.mockResolvedValue({
        id: 'proj-public-uuid',
        name: 'Open Climate Science',
        identifier: 'OCS',
        isActive: true,
      });
      const pendingInvite = {
        id: 'invite-pending-uuid',
        projectId: 'proj-public-uuid',
        email: mockUser.email,
        role: ProjectMemberRole.contributor,
        status: InvitationStatus.pending,
        expiresAt: new Date(Date.now() + 100000),
      };
      mockRepo.findPendingByProjectAndEmail.mockResolvedValue(pendingInvite);
      mockRepo.findById = jest.fn().mockResolvedValue(pendingInvite);

      const result = await invitationService.joinByCode('OCS', mockUser as any);

      expect(result.message).toBe('Successfully joined project');
      expect(mockRepo.updateStatus).toHaveBeenCalledWith(
        'invite-pending-uuid',
        InvitationStatus.accepted,
      );
      expect(mockCache.del).toHaveBeenCalled();
    });

    it('should return already-member message if caller is already enrolled', async () => {
      mockRepo.findProjectByIdOrIdentifier.mockResolvedValue({
        id: 'proj-existing-uuid',
        name: 'Existing Lab',
        identifier: 'LAB',
      });
      mockRepo.findMember.mockResolvedValue({
        userId: mockUser.id,
        role: ProjectMemberRole.contributor,
      });

      const result = await invitationService.joinByCode('LAB', mockUser as any);

      expect(result.message).toBe('You are already a member of this project');
      expect(mockRepo.addProjectMember).not.toHaveBeenCalled();
    });

    it('should accept pending invitation when valid token is supplied', async () => {
      const mockInvite = {
        id: 'invite-123',
        projectId: 'proj-any-uuid',
        email: 'researcher@flux.ac.vn',
        role: ProjectMemberRole.contributor,
        status: InvitationStatus.pending,
        expiresAt: new Date(Date.now() + 100000),
        project: { id: 'proj-any-uuid', name: 'Valid Project' },
      };
      mockRepo.findByTokenHash.mockResolvedValue(mockInvite);
      mockRepo.findById = jest.fn().mockResolvedValue(mockInvite);

      const result = await invitationService.joinByCode(
        'valid-token-123',
        mockUser as any,
      );

      expect(result.message).toBe('Successfully joined project');
      expect(mockRepo.updateStatus).toHaveBeenCalledWith(
        'invite-123',
        InvitationStatus.accepted,
      );
      expect(mockCache.del).toHaveBeenCalled();
    });
  });

  describe('InvitationService - Role Escalation & Invariant Protection in createInvitation', () => {
    let invitationService: InvitationService;
    let mockRepo: any;

    beforeEach(() => {
      mockRepo = {
        findProjectByIdOrIdentifier: jest.fn().mockResolvedValue({
          id: 'proj-123',
          name: 'Genome Project',
          isActive: true,
        }),
        findUserById: jest.fn().mockResolvedValue({
          id: 'inviter-uuid',
          email: 'pi@flux.ac.vn',
        }),
        findUserByEmail: jest.fn().mockResolvedValue(null),
        findMember: jest.fn().mockResolvedValue(null),
        findPendingByProjectAndEmail: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'new-invite-id' }),
      };

      invitationService = new InvitationService(mockRepo);
    });

    it('should throw ForbiddenException when attempting to invite with owner role', async () => {
      await expect(
        invitationService.createInvitation(
          'proj-123',
          { email: 'newmember@flux.ac.vn', role: ProjectMemberRole.owner },
          'inviter-uuid',
        ),
      ).rejects.toThrow(ForbiddenException);

      expect(mockRepo.create).not.toHaveBeenCalled();
    });

    it('should throw BadRequestException when caller attempts to invite themselves', async () => {
      await expect(
        invitationService.createInvitation(
          'proj-123',
          { email: 'pi@flux.ac.vn', role: ProjectMemberRole.contributor },
          'inviter-uuid',
        ),
      ).rejects.toThrow(BadRequestException);

      expect(mockRepo.create).not.toHaveBeenCalled();
    });

    it('should throw BadRequestException when inviting an email that is already a member', async () => {
      mockRepo.findUserByEmail.mockResolvedValue({
        id: 'existing-member-uuid',
      });
      mockRepo.findMember.mockResolvedValue({ userId: 'existing-member-uuid' });

      await expect(
        invitationService.createInvitation(
          'proj-123',
          {
            email: 'colleague@flux.ac.vn',
            role: ProjectMemberRole.contributor,
          },
          'inviter-uuid',
        ),
      ).rejects.toThrow(BadRequestException);

      expect(mockRepo.create).not.toHaveBeenCalled();
    });

    it('should throw BadRequestException when inviting to an archived/inactive project', async () => {
      mockRepo.findProjectByIdOrIdentifier.mockResolvedValue({
        id: 'proj-archived',
        isActive: false,
      });

      await expect(
        invitationService.createInvitation(
          'proj-archived',
          { email: 'new@flux.ac.vn', role: ProjectMemberRole.contributor },
          'inviter-uuid',
        ),
      ).rejects.toThrow(BadRequestException);

      expect(mockRepo.create).not.toHaveBeenCalled();
    });
  });

  describe('CoreRepository - Atomic Sequential Identifier Allocation', () => {
    let repo: CoreRepository;
    let mockPrisma: any;

    beforeEach(() => {
      mockPrisma = {
        $transaction: jest.fn((cb) => cb(mockPrisma)),
        project: {
          findFirst: jest.fn().mockResolvedValue({
            id: '7b9b0c20-67c8-4796-932d-20d0fca56641',
            identifier: 'RES',
            name: 'Research Lab',
            workItemSequence: 41,
          }),
          update: jest.fn().mockResolvedValue({
            id: '7b9b0c20-67c8-4796-932d-20d0fca56641',
            identifier: 'RES',
            name: 'Research Lab',
            workItemSequence: 42,
          }),
        },
      };

      repo = new CoreRepository(mockPrisma);
    });

    it('should atomically increment workItemSequence to prevent race conditions and duplicate codes', async () => {
      const result = await repo.allocateWorkItemIdentifier(
        '7b9b0c20-67c8-4796-932d-20d0fca56641',
      );

      expect(mockPrisma.project.update).toHaveBeenCalledWith({
        where: { id: '7b9b0c20-67c8-4796-932d-20d0fca56641' },
        data: {
          workItemSequence: { increment: 1 },
        },
        select: {
          identifier: true,
          workItemSequence: true,
        },
      });

      expect(result.sequenceNumber).toBe(42);
      expect(result.identifier).toBe('RES-42');
    });
  });

  describe('CoreService - Module Whitelist & Input Sanitization', () => {
    it('should permit the 5 valid project feature modules: overview, work_items, cycles, views, pages', () => {
      expect(ALLOWED_PROJECT_MODULES.has('overview')).toBe(true);
      expect(ALLOWED_PROJECT_MODULES.has('work_items')).toBe(true);
      expect(ALLOWED_PROJECT_MODULES.has('work-items')).toBe(true);
      expect(ALLOWED_PROJECT_MODULES.has('cycles')).toBe(true);
      expect(ALLOWED_PROJECT_MODULES.has('views')).toBe(true);
      expect(ALLOWED_PROJECT_MODULES.has('pages')).toBe(true);

      // Verify removed / out-of-scope modules are disallowed
      expect(ALLOWED_PROJECT_MODULES.has('stickies')).toBe(false);
      expect(ALLOWED_PROJECT_MODULES.has('storage')).toBe(false);
      expect(ALLOWED_PROJECT_MODULES.has('analytics')).toBe(false);
      expect(ALLOWED_PROJECT_MODULES.has('library')).toBe(false);
    });

    it('should filter out disallowed modules and fallback to standard 5 modules', () => {
      const untrustedClientInput = [
        'overview',
        'work_items',
        'cycles',
        'stickies',
        'storage',
        'library',
        'malicious_plugin',
      ];
      const sanitized = sanitizeModules(untrustedClientInput);

      expect(sanitized).toEqual(['overview', 'work_items', 'cycles']);
    });

    it('should correctly derive project prefix from name or acronym', () => {
      expect(deriveProjectPrefix(null, 'Deep Learning Genome')).toBe('DLG');
      expect(deriveProjectPrefix('BIO', 'Any Name')).toBe('BIO');
      expect(deriveProjectPrefix(null, 'Flux')).toBe('FLUX');
    });
  });

  describe('MemberService - Single-Owner Invariant Protection', () => {
    let memberService: MemberService;
    let mockMemberRepo: any;

    beforeEach(() => {
      mockMemberRepo = {
        findMember: jest.fn(),
        findProject: jest.fn().mockResolvedValue({ id: 'proj-123' }),
        countOwners: jest.fn(),
        updateMemberRole: jest.fn(),
        deleteMember: jest.fn(),
        unassignMemberWorkItems: jest.fn().mockResolvedValue(0),
      };

      memberService = new MemberService(mockMemberRepo);
    });

    it('should prevent demoting the only owner of a project', async () => {
      mockMemberRepo.findMember.mockResolvedValue({
        userId: 'owner-1',
        role: ProjectMemberRole.owner,
      });
      mockMemberRepo.countOwners.mockResolvedValue(1);

      await expect(
        memberService.updateMemberRole('proj-123', 'owner-1', {
          role: ProjectMemberRole.contributor,
        }),
      ).rejects.toThrow(ForbiddenException);

      expect(mockMemberRepo.updateMemberRole).not.toHaveBeenCalled();
    });

    it('should prevent removing the only owner of a project', async () => {
      mockMemberRepo.findMember.mockResolvedValue({
        userId: 'owner-1',
        role: ProjectMemberRole.owner,
      });
      mockMemberRepo.countOwners.mockResolvedValue(1);

      await expect(
        memberService.removeMember('proj-123', 'owner-1'),
      ).rejects.toThrow(ForbiddenException);

      expect(mockMemberRepo.deleteMember).not.toHaveBeenCalled();
    });

    it('should allow promoting a member to coordinator role', async () => {
      mockMemberRepo.findMember.mockResolvedValue({
        userId: 'member-2',
        role: ProjectMemberRole.contributor,
      });
      mockMemberRepo.updateMemberRole.mockResolvedValue({
        userId: 'member-2',
        role: ProjectMemberRole.coordinator,
      });

      const result = await memberService.updateMemberRole('proj-123', 'member-2', {
        role: ProjectMemberRole.coordinator,
      });

      expect(result.member.role).toBe(ProjectMemberRole.coordinator);
      expect(mockMemberRepo.updateMemberRole).toHaveBeenCalledWith(
        'proj-123',
        'member-2',
        ProjectMemberRole.coordinator,
      );
    });

    it('should allow assigning a member to reviewer role', async () => {
      mockMemberRepo.findMember.mockResolvedValue({
        userId: 'member-3',
        role: ProjectMemberRole.contributor,
      });
      mockMemberRepo.updateMemberRole.mockResolvedValue({
        userId: 'member-3',
        role: ProjectMemberRole.reviewer,
      });

      const result = await memberService.updateMemberRole('proj-123', 'member-3', {
        role: ProjectMemberRole.reviewer,
      });

      expect(result.member.role).toBe(ProjectMemberRole.reviewer);
      expect(mockMemberRepo.updateMemberRole).toHaveBeenCalledWith(
        'proj-123',
        'member-3',
        ProjectMemberRole.reviewer,
      );
    });
  });
});
