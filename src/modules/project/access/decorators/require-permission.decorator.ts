import { SetMetadata, CustomDecorator } from '@nestjs/common';
import { Permission } from '../enums/permission.enum';

export const PERMISSIONS_KEY = 'permissions';

/**
 * Standard @RequirePermission(...) and @RequirePermissions(...) decorator.
 * Enforces that the caller has all specified permissions in the project.
 * Works seamlessly with Role Baseline + Member Permission Overrides.
 *
 * Usage:
 *   @RequirePermission(Permission.DOCUMENT_DELETE)
 *   @RequirePermissions(Permission.WORK_ITEM_CREATE, Permission.WORK_ITEM_ASSIGN)
 */
export const RequirePermissions = (
  ...permissions: Permission[]
): CustomDecorator<string> => SetMetadata(PERMISSIONS_KEY, permissions);

export const RequirePermission = RequirePermissions;
export const Permissions = RequirePermissions;
