import { Role } from '../enums/role.enum';
import { Permission } from '../enums/permission.enum';

export type PermissionOverrideMap = Record<string, boolean>;

export interface MemberAccessContext {
  userId: string;
  projectId: string;
  role: Role;
  permissionOverrides: PermissionOverrideMap;
  effectivePermissions: readonly Permission[];
  joinedAt?: Date;
  user?: {
    id: string;
    email: string;
    name: string;
    avatar: string | null;
    status: string;
  } | null;
}

export interface AuthzProjectContext {
  id: string;
  createdById: string;
}

export interface IAccessRepository {
  findProjectContext(projectId: string): Promise<AuthzProjectContext | null>;
  findMemberAccessContext(
    projectId: string,
    userId: string,
  ): Promise<MemberAccessContext | null>;
  findMemberRole(projectId: string, userId: string): Promise<Role | null>;
  updateMemberOverrides(
    projectId: string,
    userId: string,
    overrides: PermissionOverrideMap,
  ): Promise<void>;
}
