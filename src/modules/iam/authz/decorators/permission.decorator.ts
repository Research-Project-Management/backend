import { SetMetadata, CustomDecorator } from '@nestjs/common';
import { Permission } from '../enums/permission.enum';

export const PERMISSIONS_KEY = 'permissions';

/**
 * Standard @RequirePermissions(...) decorator.
 * Usage:
 *   @RequirePermissions(Permission.PROJECT_UPDATE)
 *   @RequirePermissions(Permission.WORK_ITEM_CREATE, Permission.WORK_ITEM_ASSIGN)
 */
export const RequirePermissions = (
  ...permissions: Permission[]
): CustomDecorator<string> => SetMetadata(PERMISSIONS_KEY, permissions);

export const Permissions = RequirePermissions;
