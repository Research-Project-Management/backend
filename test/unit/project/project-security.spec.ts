import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { InvitationStatus, Role } from '@prisma/client';
import { fromPartial } from '@total-typescript/shoehorn';
import type { PrismaService, RedisCacheService } from '@/core';
import type { AuthenticatedUser } from '@/modules/identity/identity.facade';
import { CoreRepository } from '@/modules/project/core/core.repository';
import {
  ALLOWED_PROJECT_MODULES,
  sanitizeModules,
} from '@/modules/project/core/core.service';
import { deriveProjectPrefix } from '@/modules/project/core/utils/identifier.util';
import { InvitationRepository } from '@/modules/project/invitation/invitation.repository';
import { InvitationService } from '@/modules/project/invitation/invitation.service';
import { MemberRepository } from '@/modules/project/member/member.repository';
import { MemberService } from '@/modules/project/member/member.service';

describe('Project Security: Invitations, Atomic Identifiers & Single-Owner Governance', () => {
  describe('InvitationService - Zero-Trust joinByCode & createInvitation', () => {
    let invitationService: InvitationService;
    let mockRepo: jest.Mocked<InvitationRepository>;
    let mockCache: jest.Mocked<RedisCacheService>;

    const mockUser = fromPartial<AuthenticatedUser>({
      id: 'd3b07384-d113-4678-831e-4eeea6608930',
      email: 'researcher@flux.ac.vn',
    });

    beforeEach(() => {
      mockRepo = fromPartial<jest.Mocked<InvitationRepository>>({
        findById: jest.fn(),
        findByTokenHash: jest.fn().mockResolvedValue(null),
        findProjectByIdOrIdentifier: jest.fn(),
        findProjectByLinkToken: jest.fn().mockResolvedValue(null),
        findMember: jest.fn().mockResolvedValue(null),
        findPendingByProjectAndEmail: jest.fn().mockResolvedValue(null),
        addProjectMember: jest.fn().mockResolvedValue({}),
        updateStatus: jest.fn().mockResolvedValue({}),
        findUserById: jest.fn(),
        findUserByEmail: jest.fn(),
        create: jest.fn(),
      });
      mockCache = fromPartial<jest.Mocked<RedisCacheService>>({
        del: jest.fn().mockResolvedValue(1),
      });
      invitationService = new InvitationService(mockRepo, mockCache);
    });

    it('enforces anti-BOLA on joinByCode while accepting valid email or token invites and handling existing members', async () => {
      mockRepo.findProjectByIdOrIdentifier.mockResolvedValue(
        fromPartial({
          id: 'proj-private-uuid',
          name: 'Private Cancer Research',
          identifier: 'PCR',
          isActive: true,
        }),
      );

      await expect(
        invitationService.joinByCode('PCR', mockUser),
      ).rejects.toThrow(ForbiddenException);
      expect(mockRepo.addProjectMember).not.toHaveBeenCalled();

      // Pending invite by email
      const pendingInvite = {
        id: 'invite-pending-uuid',
        projectId: 'proj-private-uuid',
        email: mockUser.email,
        role: Role.contributor,
        status: InvitationStatus.pending,
        expiresAt: new Date(Date.now() + 100_000),
      };
      mockRepo.findPendingByProjectAndEmail.mockResolvedValueOnce(
        fromPartial(pendingInvite),
      );
      mockRepo.findById.mockResolvedValueOnce(fromPartial(pendingInvite));

      await expect(
        invitationService.joinByCode('PCR', mockUser),
      ).resolves.toMatchObject({ message: 'Successfully joined project' });
      expect(mockRepo.updateStatus).toHaveBeenCalledWith(
        'invite-pending-uuid',
        InvitationStatus.accepted,
      );

      // Already enrolled member
      mockRepo.findMember.mockResolvedValueOnce(
        fromPartial({ userId: mockUser.id, role: Role.contributor }),
      );
      await expect(
        invitationService.joinByCode('PCR', mockUser),
      ).resolves.toMatchObject({
        message: 'You are already a member of this project',
      });

      // Valid token invite
      const tokenInvite = {
        id: 'invite-token-123',
        projectId: 'proj-any-uuid',
        email: mockUser.email,
        role: Role.contributor,
        status: InvitationStatus.pending,
        expiresAt: new Date(Date.now() + 100_000),
        project: { id: 'proj-any-uuid', name: 'Valid Project' },
      };
      mockRepo.findByTokenHash.mockResolvedValueOnce(fromPartial(tokenInvite));
      mockRepo.findById.mockResolvedValueOnce(fromPartial(tokenInvite));

      await expect(
        invitationService.joinByCode('valid-token-123', mockUser),
      ).resolves.toMatchObject({ message: 'Successfully joined project' });
    });

    it('blocks role escalation, self-invites, non-existent users, existing members, and inactive projects in createInvitation', async () => {
      mockRepo.findProjectByIdOrIdentifier.mockResolvedValue(
        fromPartial({ id: 'proj-123', name: 'Genome Project', isActive: true }),
      );
      mockRepo.findUserById.mockResolvedValue(
        fromPartial({ id: 'inviter-uuid', email: 'pi@flux.ac.vn' }),
      );
      mockRepo.findUserByEmail.mockResolvedValue(
        fromPartial({ id: 'target-user-uuid', email: 'colleague@flux.ac.vn' }),
      );

      // Owner role escalation blocked
      await expect(
        invitationService.createInvitation(
          'proj-123',
          { email: 'colleague@flux.ac.vn', role: Role.owner },
          'inviter-uuid',
        ),
      ).rejects.toThrow(ForbiddenException);

      // Self-invite blocked
      await expect(
        invitationService.createInvitation(
          'proj-123',
          { email: 'pi@flux.ac.vn', role: Role.contributor },
          'inviter-uuid',
        ),
      ).rejects.toThrow(BadRequestException);

      // Unknown user email -> 404
      mockRepo.findUserByEmail.mockResolvedValueOnce(null);
      await expect(
        invitationService.createInvitation(
          'proj-123',
          { email: 'outsider@gmail.com', role: Role.contributor },
          'inviter-uuid',
        ),
      ).rejects.toThrow(NotFoundException);

      // Already a member -> 400
      mockRepo.findMember.mockResolvedValueOnce(
        fromPartial({ userId: 'target-user-uuid' }),
      );
      await expect(
        invitationService.createInvitation(
          'proj-123',
          { email: 'colleague@flux.ac.vn', role: Role.contributor },
          'inviter-uuid',
        ),
      ).rejects.toThrow(BadRequestException);

      // Inactive project -> 400
      mockRepo.findProjectByIdOrIdentifier.mockResolvedValueOnce(
        fromPartial({ id: 'proj-archived', isActive: false }),
      );
      await expect(
        invitationService.createInvitation(
          'proj-archived',
          { email: 'colleague@flux.ac.vn', role: Role.contributor },
          'inviter-uuid',
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('CoreRepository & CoreService Module Sanitization', () => {
    it('atomically increments workItemSequence, filters disallowed modules, and derives project prefixes', async () => {
      const updateProject = jest.fn().mockResolvedValue({
        id: '7b9b0c20-67c8-4796-932d-20d0fca56641',
        identifier: 'RES',
        name: 'Research Lab',
        workItemSequence: 42,
      });
      const mockTx = fromPartial<PrismaService>({
        project: {
          findFirst: jest.fn().mockResolvedValue({
            id: '7b9b0c20-67c8-4796-932d-20d0fca56641',
            identifier: 'RES',
            workItemSequence: 41,
          }),
          update: updateProject,
        },
      });
      const mockPrisma = fromPartial<PrismaService>({
        $transaction: jest.fn((cb: (tx: unknown) => Promise<unknown>) =>
          cb(mockTx),
        ) as never,
        project: mockTx.project,
      });

      const repo = new CoreRepository(mockPrisma);
      await expect(
        repo.allocateWorkItemIdentifier('7b9b0c20-67c8-4796-932d-20d0fca56641'),
      ).resolves.toEqual({
        sequenceNumber: 42,
        identifier: 'RES-42',
      });
      expect(updateProject).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { workItemSequence: { increment: 1 } },
        }),
      );

      expect([...ALLOWED_PROJECT_MODULES]).toEqual([
        'overview',
        'work-items',
        'pages',
        'chat',
      ]);
      expect(
        sanitizeModules([
          'overview',
          'work_items',
          'cycles',
          'stickies',
          'storage',
          'malicious_plugin',
        ]),
      ).toEqual(['overview', 'work-items']);
      expect(sanitizeModules([])).toEqual([
        'overview',
        'work-items',
        'pages',
        'chat',
      ]);

      expect(deriveProjectPrefix(null, 'Deep Learning Genome')).toBe('DLG');
      expect(deriveProjectPrefix('BIO', 'Any Name')).toBe('BIO');
      expect(deriveProjectPrefix(null, 'Flux')).toBe('FLUX');
    });
  });

  describe('MemberService - Single-Owner Invariant & Atomic Ownership Transfer', () => {
    let memberService: MemberService;
    let mockMemberRepo: jest.Mocked<MemberRepository>;

    beforeEach(() => {
      mockMemberRepo = fromPartial<jest.Mocked<MemberRepository>>({
        findMember: jest.fn(),
        findProject: jest.fn().mockResolvedValue({ id: 'proj-123' }),
        countOwners: jest.fn(),
        updateMemberRole: jest.fn(),
        deleteMember: jest.fn(),
        transferOwnership: jest.fn(),
        unassignMemberWorkItems: jest.fn().mockResolvedValue(0),
      });
      memberService = new MemberService(mockMemberRepo);
    });

    it('prevents demoting or removing the sole owner while permitting valid role updates', async () => {
      mockMemberRepo.findMember.mockResolvedValue(
        fromPartial({ userId: 'owner-1', role: Role.owner }),
      );
      mockMemberRepo.countOwners.mockResolvedValue(1);

      await expect(
        memberService.updateMemberRole('proj-123', 'owner-1', {
          role: Role.contributor,
        }),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        memberService.removeMember('proj-123', 'owner-1'),
      ).rejects.toThrow(ForbiddenException);

      mockMemberRepo.findMember.mockResolvedValueOnce(
        fromPartial({ userId: 'member-2', role: Role.contributor }),
      );
      mockMemberRepo.updateMemberRole.mockResolvedValueOnce(
        fromPartial({ userId: 'member-2', role: Role.coordinator }),
      );
      const promoted = await memberService.updateMemberRole(
        'proj-123',
        'member-2',
        { role: Role.coordinator },
      );
      expect(promoted.member.role).toBe(Role.coordinator);
    });

    it('enforces ownership transfer guards and atomically swaps previous owner to coordinator', async () => {
      await expect(
        memberService.transferOwnership('proj-123', 'owner-1', 'owner-1'),
      ).rejects.toThrow(BadRequestException);

      mockMemberRepo.findProject.mockResolvedValueOnce(null);
      await expect(
        memberService.transferOwnership('proj-123', 'owner-1', 'member-2'),
      ).rejects.toThrow(NotFoundException);

      mockMemberRepo.findMember.mockResolvedValueOnce(
        fromPartial({ userId: 'member-1', role: Role.coordinator }),
      );
      await expect(
        memberService.transferOwnership('proj-123', 'member-1', 'member-2'),
      ).rejects.toThrow(ForbiddenException);

      mockMemberRepo.findMember
        .mockResolvedValueOnce(
          fromPartial({ userId: 'owner-1', role: Role.owner }),
        )
        .mockResolvedValueOnce(null);
      await expect(
        memberService.transferOwnership('proj-123', 'owner-1', 'stranger-2'),
      ).rejects.toThrow(NotFoundException);

      mockMemberRepo.findMember
        .mockResolvedValueOnce(
          fromPartial({ userId: 'owner-1', role: Role.owner }),
        )
        .mockResolvedValueOnce(
          fromPartial({ userId: 'member-2', role: Role.contributor }),
        );
      mockMemberRepo.transferOwnership.mockResolvedValueOnce(
        fromPartial({
          previousOwner: { userId: 'owner-1', role: Role.coordinator },
          newOwner: { userId: 'member-2', role: Role.owner },
        }),
      );

      const transferred = await memberService.transferOwnership(
        'proj-123',
        'owner-1',
        'member-2',
      );
      expect(transferred.previousOwner.role).toBe(Role.coordinator);
      expect(transferred.newOwner.role).toBe(Role.owner);
    });
  });
});
