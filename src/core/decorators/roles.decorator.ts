import { SetMetadata } from '@nestjs/common';
import { MemberRole } from '@prisma/client';

export const ROLES_KEY = 'roles';
export const Roles = (
  ...roles: (MemberRole | 'owner' | 'admin' | 'member' | 'viewer')[]
) => SetMetadata(ROLES_KEY, roles);
