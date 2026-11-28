import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { fromPartial } from '@total-typescript/shoehorn';
import type { PrismaService } from '@/core';
import { RedisCacheService } from '@/core/infrastructure/redis/cache.service';
import { CacheInvalidationListener } from '@/core/infrastructure/redis/invalidation.listener';
import { AccessService } from '@/modules/project/access/access.service';
import { AccessConfigService } from '@/modules/project/access/config/access.config';
import {
  computeEffectivePermissions,
  evaluateMemberPermission,
  ROLE_PERMISSIONS,
} from '@/modules/project/access/constants/permission.constant';
import { Permission } from '@/modules/project/access/enums/permission.enum';
import { Role } from '@/modules/project/access/enums/role.enum';
import { ProjectAccessGuard } from '@/modules/project/access/guards/project-access.guard';
import {
  type PolicySubject,
  ResourceAccessPolicy,
} from '@/modules/project/access/policies/resource-access.policy';
import { ProjectResourceResolver } from '@/modules/project/access/resolvers/project-resource.resolver';
import {
  ALL_PERMISSIONS_MASK,
  decodeBitmaskToPermissions,
  encodePermissionsToBitmask,
  ORDERED_PERMISSIONS,
  PERMISSION_TO_BIT,
  PermissionBitmaskUtil,
  ROLE_BASE_BITMASKS,
} from '@/modules/project/access/utils/permission-bitmask.util';

describe('Project Access Control: Bitmask RBAC, ABAC Policies, Guard & Cache Eviction', () => {
  describe('Permission Bitmask Engine & Role Matrix Parity', () => {
    it('maps all 54 unique permissions into distinct power-of-two bits within PostgreSQL BIGINT range', () => {
      const allPerms = Object.values(Permission);
      expect(allPerms).toHaveLength(54);
      expect(ORDERED_PERMISSIONS).toHaveLength(54);

      const seenBits = new Set<bigint>();
      for (const perm of ORDERED_PERMISSIONS) {
        const bit = PERMISSION_TO_BIT[perm];
        expect(bit > 0n).toBe(true);
        expect(bit & (bit - 1n)).toBe(0n);
        expect(seenBits.has(bit)).toBe(false);
        seenBits.add(bit);
      }
      expect(seenBits.size).toBe(54);
      expect(ALL_PERMISSIONS_MASK).toBe((1n << 54n) - 1n);
      expect(ALL_PERMISSIONS_MASK).toBeLessThan(9223372036854775807n);
    });

    it('round-trips subsets, ALL_PERMISSIONS_MASK, 0n, hex strings, and matches ROLE_PERMISSIONS for every role', () => {
      const sample = [
        Permission.PROJECT_VIEW,
        Permission.DOCUMENT_COMPILE,
        Permission.LIBRARY_UPLOAD,
        Permission.AI_EXECUTE,
      ];
      expect(decodeBitmaskToPermissions(encodePermissionsToBitmask(sample))).toEqual(
        expect.arrayContaining(sample),
      );
      expect(decodeBitmaskToPermissions(ALL_PERMISSIONS_MASK)).toHaveLength(54);
      expect(decodeBitmaskToPermissions(0n)).toEqual([]);

      for (const role of Object.values(Role)) {
        const legacy = new Set(ROLE_PERMISSIONS[role]);
        const bitmask = new Set(
          decodeBitmaskToPermissions(ROLE_BASE_BITMASKS[role]),
        );
        expect(bitmask).toEqual(legacy);
      }

      const coordMask = ROLE_BASE_BITMASKS[Role.COORDINATOR];
      const hex = PermissionBitmaskUtil.toHex(coordMask);
      expect(hex.startsWith('0x')).toBe(true);
      expect(PermissionBitmaskUtil.fromHex(hex)).toBe(coordMask);
      expect(PermissionBitmaskUtil.fromHex(null)).toBe(0n);
      expect(PermissionBitmaskUtil.fromHex('invalid-hex')).toBe(0n);
    });

    it('enforces OWNER bypass, member-level grant/deny overrides, computeEffectivePermissions, and O(1) hasAll/hasAny', () => {
      expect(
        PermissionBitmaskUtil.evaluate(Role.OWNER, Permission.DOCUMENT_DELETE, {
          [Permission.DOCUMENT_DELETE]: false,
        }),
      ).toBe(true);
      expect(
        PermissionBitmaskUtil.computeEffectiveBitmask(Role.OWNER, {
          [Permission.DOCUMENT_DELETE]: false,
        }),
      ).toBe(ALL_PERMISSIONS_MASK);
      expect(computeEffectivePermissions(Role.OWNER)).toHaveLength(54);

      expect(
        PermissionBitmaskUtil.evaluate(Role.REVIEWER, Permission.LIBRARY_UPLOAD),
      ).toBe(false);
      expect(
        PermissionBitmaskUtil.evaluate(
          Role.REVIEWER,
          Permission.LIBRARY_UPLOAD,
          { [Permission.LIBRARY_UPLOAD]: true },
        ),
      ).toBe(true);

      expect(
        evaluateMemberPermission(Role.CONTRIBUTOR, Permission.WORK_ITEM_DELETE, {
          [Permission.WORK_ITEM_DELETE]: false,
        }),
      ).toBe(false);

      const effective = computeEffectivePermissions(Role.CONTRIBUTOR, {
        [Permission.WORK_ITEM_DELETE]: false,
        [Permission.PROJECT_MANAGE_MEMBERS]: true,
      });
      expect(effective).not.toContain(Permission.WORK_ITEM_DELETE);
      expect(effective).toContain(Permission.PROJECT_MANAGE_MEMBERS);

      const coordinatorMask = ROLE_BASE_BITMASKS[Role.COORDINATOR];
      expect(
        PermissionBitmaskUtil.hasAll(coordinatorMask, [
          Permission.WORK_ITEM_CREATE,
          Permission.DOCUMENT_COMPILE,
        ]),
      ).toBe(true);
      expect(
        PermissionBitmaskUtil.hasAll(coordinatorMask, [
          Permission.WORK_ITEM_CREATE,
          Permission.PROJECT_DELETE,
        ]),
      ).toBe(false);
      expect(
        PermissionBitmaskUtil.hasAny(coordinatorMask, [
          Permission.PROJECT_DELETE,
          Permission.DOCUMENT_COMPILE,
        ]),
      ).toBe(true);
      expect(
        PermissionBitmaskUtil.hasAny(coordinatorMask, [
          Permission.PROJECT_DELETE,
          Permission.PROJECT_MANAGE_MEMBERS,
        ]),
      ).toBe(false);
    });
  });

  describe('ResourceAccessPolicy (ABAC Ownership, Academic Integrity & Freeze Guards)', () => {
    const policy = new ResourceAccessPolicy();
    const author: PolicySubject = { userId: 'u-author', role: Role.CONTRIBUTOR };
    const peer: PolicySubject = { userId: 'u-peer', role: Role.CONTRIBUTOR };
    const owner: PolicySubject = { userId: 'u-owner', role: Role.OWNER };
    const coord: PolicySubject = { userId: 'u-coord', role: Role.COORDINATOR };
    const reviewer: PolicySubject = { userId: 'u-rev', role: Role.REVIEWER };

    it('prevents comment tampering (even by Owner) while allowing Owner moderation deletes', () => {
      const comment = { id: 'c-1', authorId: 'u-author' };
      expect(() =>
        policy.assertCanModifyComment(author, comment, 'update'),
      ).not.toThrow();
      expect(() =>
        policy.assertCanModifyComment(peer, comment, 'update'),
      ).toThrow(ForbiddenException);
      expect(() =>
        policy.assertCanModifyComment(owner, comment, 'update'),
      ).toThrow(ForbiddenException);

      expect(() =>
        policy.assertCanModifyComment(author, comment, 'delete'),
      ).not.toThrow();
      expect(() =>
        policy.assertCanModifyComment(owner, comment, 'delete'),
      ).not.toThrow();
      expect(() =>
        policy.assertCanModifyComment(peer, comment, 'delete'),
      ).toThrow(ForbiddenException);
    });

    it('enforces work item creator/coordinator/owner boundaries, lock protection, and reviewer read-only restrictions', () => {
      const item = { id: 'wi-1', createdById: 'u-author', isLocked: false };
      const locked = { id: 'wi-2', createdById: 'u-author', isLocked: true };

      expect(() =>
        policy.assertCanModifyWorkItem(author, item, 'delete'),
      ).not.toThrow();
      expect(() =>
        policy.assertCanModifyWorkItem(peer, item, 'delete'),
      ).toThrow(ForbiddenException);
      expect(() =>
        policy.assertCanModifyWorkItem(coord, item, 'delete'),
      ).not.toThrow();
      expect(() =>
        policy.assertCanModifyWorkItem(reviewer, item, 'update'),
      ).toThrow(ForbiddenException);

      expect(() =>
        policy.assertCanModifyWorkItem(author, locked, 'update'),
      ).toThrow(ForbiddenException);
      expect(() =>
        policy.assertCanModifyWorkItem(coord, locked, 'update'),
      ).not.toThrow();
      expect(() =>
        policy.assertCanModifyWorkItem(owner, locked, 'update'),
      ).not.toThrow();
    });

    it('protects published/frozen manuscripts from contributor deletion while allowing administrative Owner deletion', () => {
      const draft = {
        id: 'd-1',
        authorId: 'u-author',
        isLocked: false,
        status: 'draft',
      };
      const published = {
        id: 'd-2',
        authorId: 'u-author',
        isLocked: true,
        status: 'published',
      };

      expect(() =>
        policy.assertCanModifyDocument(author, draft, 'delete'),
      ).not.toThrow();
      expect(() =>
        policy.assertCanModifyDocument(peer, draft, 'delete'),
      ).toThrow(ForbiddenException);
      expect(() =>
        policy.assertCanModifyDocument(author, published, 'delete'),
      ).toThrow(ForbiddenException);
      expect(() =>
        policy.assertCanModifyDocument(owner, published, 'delete'),
      ).not.toThrow();
    });
  });

  describe('ProjectAccessGuard (SEC-01 IDOR & Membership Enforcement)', () => {
    const projectAId = 'a0000000-0000-4000-8000-000000000001';
    const projectBId = 'b0000000-0000-4000-8000-000000000002';
    const pageAId = 'c0000000-0000-4000-8000-000000000003';
    const userAId = 'u0000000-0000-4000-8000-000000000001';
    const userBId = 'u0000000-0000-4000-8000-000000000002';

    it('rejects cross-project IDOR hints, rejects non-members, and attaches resolvedProjectId for authorized members', async () => {
      const resolveAuthoritativeProjectId = jest.fn();
      const guard = new ProjectAccessGuard(
        fromPartial<Reflector>({
          getAllAndOverride: jest.fn((key: string) => {
            if (key === 'roles') return [Role.CONTRIBUTOR];
            if (key === 'min_role') return Role.CONTRIBUTOR;
            if (key === 'no_project_context') return false;
            return undefined;
          }),
        }),
        fromPartial<PrismaService>({}),
        fromPartial<AccessService>({
          getMemberAccessContext: jest.fn(async (projId: string, uId: string) => {
            if (projId === projectAId && uId === userAId) {
              return {
                role: Role.CONTRIBUTOR,
                permissionOverrides: {},
                effectivePermissions: [],
                effectiveBitmask: ROLE_BASE_BITMASKS[Role.CONTRIBUTOR],
              };
            }
            return null;
          }),
          hasRole: jest.fn().mockReturnValue(true),
          hasPermission: jest.fn().mockReturnValue(true),
        }),
        fromPartial<ProjectResourceResolver>({ resolveAuthoritativeProjectId }),
        fromPartial<AccessConfigService>({
          enforcementMode: 'enforce',
          isOperator: jest.fn().mockReturnValue(false),
        }),
      );

      const makeCtx = (req: Record<string, unknown>) =>
        fromPartial<ExecutionContext>({
          getHandler: () => (() => undefined) as never,
          getClass: () => class Dummy {} as never,
          switchToHttp: () => ({ getRequest: () => req }),
        });

      // SEC-01 IDOR: foreign resource + owned project header
      resolveAuthoritativeProjectId.mockRejectedValueOnce(
        new ForbiddenException({ code: 'PROJECT_CONTEXT_MISMATCH' }),
      );
      await expect(
        guard.canActivate(
          makeCtx({
            user: { sub: userBId },
            params: { pageId: pageAId },
            headers: { 'x-project-id': projectBId },
          }),
        ),
      ).rejects.toThrow(ForbiddenException);

      // Authorized member
      resolveAuthoritativeProjectId.mockResolvedValue({
        projectId: projectAId,
        spaceId: projectAId,
        isPersonalSpace: false,
        source: 'resource',
      });
      const memberReq: Record<string, unknown> = {
        user: { sub: userAId },
        params: { pageId: pageAId },
        headers: { 'x-project-id': projectAId },
      };
      await expect(guard.canActivate(makeCtx(memberReq))).resolves.toBe(true);
      expect(memberReq.resolvedProjectId).toBe(projectAId);

      // Non-member rejected
      await expect(
        guard.canActivate(
          makeCtx({
            user: { sub: 'unrelated-user-id' },
            params: { pageId: pageAId },
            headers: {},
          }),
        ),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('CacheInvalidationListener (Zero-Latency Access Revocation)', () => {
    it('evicts member context, role, and permission keys on member_removed, member_updated, and ownership_transferred', async () => {
      const del = jest.fn().mockResolvedValue(1);
      const listener = new CacheInvalidationListener(
        fromPartial<RedisCacheService>({
          del,
          delPattern: jest.fn().mockResolvedValue(1),
        }),
      );

      const projectId = 'proj-9999-uuid';
      await listener.handleProjectChanged({
        projectId,
        verb: 'member_removed',
        entityId: projectId,
        oldValue: 'u-kicked',
      });
      expect(del).toHaveBeenCalledWith(`project:access:${projectId}:u-kicked`);
      expect(del).toHaveBeenCalledWith(
        `project:access:role:${projectId}:u-kicked`,
      );
      expect(del).toHaveBeenCalledWith(
        `project:access:perms:${projectId}:u-kicked`,
      );

      del.mockClear();
      await listener.handleProjectChanged({
        projectId,
        verb: 'member_updated',
        entityId: projectId,
        userId: 'u-demoted',
      });
      expect(del).toHaveBeenCalledWith(`project:access:${projectId}:u-demoted`);

      del.mockClear();
      await listener.handleProjectChanged({
        projectId,
        verb: 'ownership_transferred',
        entityId: projectId,
        oldValue: 'u-old-owner',
        newValue: 'u-new-owner',
      });
      expect(del).toHaveBeenCalledWith(
        `project:access:${projectId}:u-old-owner`,
      );
      expect(del).toHaveBeenCalledWith(
        `project:access:${projectId}:u-new-owner`,
      );
    });
  });
});
