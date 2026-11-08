import { Permission } from '@/modules/project/access/enums/permission.enum';
import { Role } from '@/modules/project/access/enums/role.enum';
import {
  ORDERED_PERMISSIONS,
  PERMISSION_TO_BIT,
  ALL_PERMISSIONS_MASK,
  ROLE_BASE_BITMASKS,
  encodePermissionsToBitmask,
  decodeBitmaskToPermissions,
  PermissionBitmaskUtil,
} from '@/modules/project/access/utils/permission-bitmask.util';
import {
  ROLE_PERMISSIONS,
  evaluateMemberPermission,
  computeEffectivePermissions,
  roleHasPermission,
} from '@/modules/project/access/constants/permission.constant';

describe('Project Access Bitmask Engine & RBAC Optimization', () => {
  describe('Mathematical Invariants & Bit Mapping', () => {
    it('should map exactly 54 unique permissions into 54 unique power-of-two bits', () => {
      const allPerms = Object.values(Permission);
      expect(allPerms.length).toBe(54);
      expect(ORDERED_PERMISSIONS.length).toBe(54);

      const seenBits = new Set<bigint>();
      for (const perm of ORDERED_PERMISSIONS) {
        const bit = PERMISSION_TO_BIT[perm];
        expect(bit).toBeDefined();
        expect(bit > 0n).toBe(true);
        // Bit must be a power of 2: (bit & (bit - 1n)) === 0n
        expect((bit & (bit - 1n))).toBe(0n);
        expect(seenBits.has(bit)).toBe(false);
        seenBits.add(bit);
      }
      expect(seenBits.size).toBe(54);
    });

    it('should fit all 54 permissions within signed 64-bit integer range (PostgreSQL BIGINT)', () => {
      const MAX_POSTGRES_BIGINT = 9223372036854775807n; // 2^63 - 1
      expect(ALL_PERMISSIONS_MASK).toBeLessThan(MAX_POSTGRES_BIGINT);
      expect(ALL_PERMISSIONS_MASK).toBe((1n << 54n) - 1n);
    });
  });

  describe('Encoding & Decoding Round-Trip', () => {
    it('should perfectly round-trip any subset of permissions', () => {
      const samplePerms = [
        Permission.PROJECT_VIEW,
        Permission.DOCUMENT_COMPILE,
        Permission.LIBRARY_UPLOAD,
        Permission.AI_EXECUTE,
      ];

      const mask = encodePermissionsToBitmask(samplePerms);
      const decoded = decodeBitmaskToPermissions(mask);

      expect(decoded.length).toBe(samplePerms.length);
      for (const p of samplePerms) {
        expect(decoded).toContain(p);
      }
    });

    it('should decode ALL_PERMISSIONS_MASK into all 54 canonical permissions', () => {
      const decoded = decodeBitmaskToPermissions(ALL_PERMISSIONS_MASK);
      expect(decoded.length).toBe(54);
      expect(decoded).toEqual(expect.arrayContaining(Object.values(Permission)));
    });

    it('should decode 0n into an empty array', () => {
      expect(decodeBitmaskToPermissions(0n)).toEqual([]);
    });
  });

  describe('Role Baseline Bitmask Parity with Canonical Role Matrix', () => {
    it.each(Object.values(Role))(
      'should match legacy ROLE_PERMISSIONS for role %s with 100% exact parity',
      (role) => {
        const legacyList = new Set(ROLE_PERMISSIONS[role]);
        const bitmaskList = new Set(
          decodeBitmaskToPermissions(ROLE_BASE_BITMASKS[role]),
        );

        expect(bitmaskList.size).toBe(legacyList.size);
        for (const perm of legacyList) {
          expect(bitmaskList.has(perm)).toBe(true);
        }
      },
    );
  });

  describe('PermissionBitmaskUtil Evaluation & Overrides', () => {
    it('should grant OWNER unconditional bypass regardless of explicit overrides', () => {
      const hasPerm = PermissionBitmaskUtil.evaluate(
        Role.OWNER,
        Permission.DOCUMENT_DELETE,
        { [Permission.DOCUMENT_DELETE]: false },
      );
      expect(hasPerm).toBe(true);

      const effectiveMask = PermissionBitmaskUtil.computeEffectiveBitmask(
        Role.OWNER,
        { [Permission.DOCUMENT_DELETE]: false },
      );
      expect(effectiveMask).toBe(ALL_PERMISSIONS_MASK);
    });

    it('should respect member-level grant override for non-owner', () => {
      // REVIEWER by default lacks LIBRARY_UPLOAD
      expect(
        PermissionBitmaskUtil.evaluate(Role.REVIEWER, Permission.LIBRARY_UPLOAD),
      ).toBe(false);

      // Explicit grant
      const granted = PermissionBitmaskUtil.evaluate(
        Role.REVIEWER,
        Permission.LIBRARY_UPLOAD,
        { [Permission.LIBRARY_UPLOAD]: true },
      );
      expect(granted).toBe(true);
    });

    it('should respect member-level deny override for non-owner', () => {
      // CONTRIBUTOR by default has WORK_ITEM_DELETE
      expect(
        PermissionBitmaskUtil.evaluate(
          Role.CONTRIBUTOR,
          Permission.WORK_ITEM_DELETE,
        ),
      ).toBe(true);

      // Explicit deny
      const denied = PermissionBitmaskUtil.evaluate(
        Role.CONTRIBUTOR,
        Permission.WORK_ITEM_DELETE,
        { [Permission.WORK_ITEM_DELETE]: false },
      );
      expect(denied).toBe(false);
    });

    it('should correctly evaluate hasAll and hasAny in O(1) clock cycles', () => {
      const coordinatorMask = ROLE_BASE_BITMASKS[Role.COORDINATOR];

      // COORDINATOR has WORK_ITEM_CREATE, DOCUMENT_COMPILE, LIBRARY_UPLOAD
      expect(
        PermissionBitmaskUtil.hasAll(coordinatorMask, [
          Permission.WORK_ITEM_CREATE,
          Permission.DOCUMENT_COMPILE,
          Permission.LIBRARY_UPLOAD,
        ]),
      ).toBe(true);

      // COORDINATOR does NOT have PROJECT_DELETE
      expect(
        PermissionBitmaskUtil.hasAll(coordinatorMask, [
          Permission.WORK_ITEM_CREATE,
          Permission.PROJECT_DELETE,
        ]),
      ).toBe(false);

      // COORDINATOR has AT LEAST ONE of [PROJECT_DELETE, DOCUMENT_COMPILE]
      expect(
        PermissionBitmaskUtil.hasAny(coordinatorMask, [
          Permission.PROJECT_DELETE,
          Permission.DOCUMENT_COMPILE,
        ]),
      ).toBe(true);

      // COORDINATOR has NONE of [PROJECT_DELETE, PROJECT_MANAGE_MEMBERS]
      expect(
        PermissionBitmaskUtil.hasAny(coordinatorMask, [
          Permission.PROJECT_DELETE,
          Permission.PROJECT_MANAGE_MEMBERS,
        ]),
      ).toBe(false);
    });
  });

  describe('Hex Serialization & Deserialization', () => {
    it('should serialize bitmask to compact hex and parse it back losslessly', () => {
      const mask = ROLE_BASE_BITMASKS[Role.COORDINATOR];
      const hex = PermissionBitmaskUtil.toHex(mask);

      expect(hex.startsWith('0x')).toBe(true);
      expect(hex.length).toBeLessThanOrEqual(18); // "0x" + up to 14 hex chars

      const restoredMask = PermissionBitmaskUtil.fromHex(hex);
      expect(restoredMask).toBe(mask);
    });

    it('should safely handle null/undefined/invalid hex strings', () => {
      expect(PermissionBitmaskUtil.fromHex(null)).toBe(0n);
      expect(PermissionBitmaskUtil.fromHex(undefined)).toBe(0n);
      expect(PermissionBitmaskUtil.fromHex('invalid-hex')).toBe(0n);
    });
  });
});
