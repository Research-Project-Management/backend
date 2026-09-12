import { Role } from '../../authz/enums/role.enum';
import { Permission } from '../../authz/enums/permission.enum';

// ─── 1. Branded Identifiers ──────────────────────────────────────────────────

export type UserId = string & { readonly __brand: unique symbol };
export type ProjectId = string & { readonly __brand: unique symbol };

export const toUserId = (id: string): UserId => id as UserId;
export const toProjectId = (id: string): ProjectId => id as ProjectId;

// ─── 2. Authenticated Context & Payload ──────────────────────────────────────

export interface AuthenticatedUser {
  readonly id: UserId;
  readonly email: string;
  readonly name: string;
  readonly avatar: string | null;
  readonly isVerified: boolean;
}

export interface JwtPayload {
  readonly sub: UserId;
  readonly email: string;
  readonly iat?: number;
  readonly exp?: number;
}

export interface AuthSessionTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
}

export interface CurrentMemberContext {
  readonly userId: UserId;
  readonly projectId: ProjectId;
  readonly role: Role;
}

// ─── 3. IAM Facade & Gateway Contracts ───────────────────────────────────────

export interface IamUserSession {
  userId: string;
  email: string;
  name: string;
  avatar?: string | null;
  status: string;
}

export interface IamAuthResult {
  valid: boolean;
  user?: IamUserSession | null;
  error?: string;
}

export interface IamPermissionCheckRequest {
  userId: string;
  projectId: string;
  permission: Permission;
}

export interface IamRoleCheckRequest {
  userId: string;
  projectId: string;
  minRole: Role;
}

export interface IamProjectMembership {
  userId: string;
  projectId: string;
  role: Role;
}

export { Role };
