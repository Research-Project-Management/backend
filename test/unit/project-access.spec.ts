import { Role } from '@/modules/project/access/enums/role.enum';
import { Permission } from '@/modules/project/access/enums/permission.enum';
import {
  evaluateMemberPermission,
  computeEffectivePermissions,
  roleHasPermission,
} from '@/modules/project/access/constants/permission.constant';

describe('Project Access & Granular Permissions Evaluation', () => {
  describe('evaluateMemberPermission', () => {
    it('should grant OWNER unconditional superuser bypass even if override is explicitly false', () => {
      const isAllowed = evaluateMemberPermission(
        Role.OWNER,
        Permission.DOCUMENT_DELETE,
        { [Permission.DOCUMENT_DELETE]: false },
      );
      expect(isAllowed).toBe(true);
    });

    it('should respect explicit deny override (false) for non-owner role', () => {
      // By baseline, CONTRIBUTOR has WORK_ITEM_DELETE
      expect(
        roleHasPermission(Role.CONTRIBUTOR, Permission.WORK_ITEM_DELETE),
      ).toBe(true);

      const isAllowed = evaluateMemberPermission(
        Role.CONTRIBUTOR,
        Permission.WORK_ITEM_DELETE,
        { [Permission.WORK_ITEM_DELETE]: false },
      );
      expect(isAllowed).toBe(false);
    });

    it('should respect explicit grant override (true) for non-owner role', () => {
      // By baseline, REVIEWER does NOT have LIBRARY_UPLOAD
      expect(
        roleHasPermission(Role.REVIEWER, Permission.LIBRARY_UPLOAD),
      ).toBe(false);

      const isAllowed = evaluateMemberPermission(
        Role.REVIEWER,
        Permission.LIBRARY_UPLOAD,
        { [Permission.LIBRARY_UPLOAD]: true },
      );
      expect(isAllowed).toBe(true);
    });

    it('should fallback to role baseline when no override is specified', () => {
      // CONTRIBUTOR has WORK_ITEM_CREATE
      expect(
        evaluateMemberPermission(Role.CONTRIBUTOR, Permission.WORK_ITEM_CREATE),
      ).toBe(true);

      // REVIEWER does not have WORK_ITEM_CREATE
      expect(
        evaluateMemberPermission(Role.REVIEWER, Permission.WORK_ITEM_CREATE),
      ).toBe(false);
    });
  });

  describe('computeEffectivePermissions', () => {
    it('should return all permissions for OWNER', () => {
      const allPerms = Object.values(Permission);
      const effective = computeEffectivePermissions(Role.OWNER);
      expect(effective.length).toBe(allPerms.length);
    });

    it('should add granted permission and remove revoked permission in effective permissions', () => {
      const effective = computeEffectivePermissions(Role.CONTRIBUTOR, {
        [Permission.WORK_ITEM_DELETE]: false,
        [Permission.PROJECT_MANAGE_MEMBERS]: true,
      });

      expect(effective).not.toContain(Permission.WORK_ITEM_DELETE);
      expect(effective).toContain(Permission.PROJECT_MANAGE_MEMBERS);
      expect(effective).toContain(Permission.WORK_ITEM_CREATE);
    });
  });
});
