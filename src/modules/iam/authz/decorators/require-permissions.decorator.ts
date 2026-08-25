import { SetMetadata, CustomDecorator } from '@nestjs/common';
import { Permission } from '../enums/permissions.enum';

export const PERMISSIONS_KEY = 'permissions';

export const RequirePermissions = (
  ...permissions: Permission[]
): CustomDecorator<string> => SetMetadata(PERMISSIONS_KEY, permissions);
