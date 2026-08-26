/**
 * IAM Repository Layer Interfaces (Ports)
 *
 * Implements Hexagonal / DDD-Lite Architecture decoupling Prisma models from services.
 */

import { User } from '@prisma/client';

export type UserStatus =
  'active' | 'suspended' | 'pending_verification' | 'deactivated';
export type AuthProvider = 'google' | 'github' | 'orcid' | 'saml' | 'local';
export type SecurityEventType =
  | 'login_success'
  | 'login_failed'
  | 'logout'
  | 'token_refreshed'
  | 'token_revoked'
  | 'token_breach_detected'
  | 'password_reset_requested'
  | 'password_reset_completed'
  | 'oauth_account_linked'
  | 'oauth_account_unlinked'
  | 'member_invited'
  | 'member_joined'
  | 'member_role_updated'
  | 'member_removed'
  | 'mfa_enabled'
  | 'mfa_disabled';

export interface IUserRepository {
  findById(id: string): Promise<User | null>;
  findByEmail(email: string): Promise<User | null>;
  createWithLocalAuth(data: {
    email: string;
    passwordHash: string;
    name: string;
    avatar?: string;
  }): Promise<User>;
  updateProfile(
    id: string,
    data: Partial<Pick<User, 'name' | 'avatar' | 'isVerified'>>,
  ): Promise<User>;
  softDelete(id: string): Promise<void>;
}

export interface IFederatedIdentityRepository {
  findByProviderSubject(
    provider: AuthProvider,
    subjectId: string,
  ): Promise<{
    id: string;
    userId: string;
    provider: string;
    providerSubjectId: string;
    email: string | null;
    profileData: unknown;
    user: User;
  } | null>;
  findByUserId(userId: string): Promise<
    Array<{
      id: string;
      userId: string;
      provider: string;
      providerSubjectId: string;
      email: string | null;
    }>
  >;
  linkIdentity(data: {
    userId: string;
    provider: AuthProvider;
    providerSubjectId: string;
    email?: string;
    profileData?: Record<string, unknown>;
  }): Promise<unknown>;
  unlinkIdentity(userId: string, provider: AuthProvider): Promise<void>;
}

export interface IRefreshTokenRepository {
  createSession(data: {
    userId: string;
    tokenHash: string;
    familyId?: string;
    parentId?: string;
    expiresAt: Date;
    userAgent?: string;
    ipAddress?: string;
    deviceType?: string;
  }): Promise<{
    id: string;
    userId: string;
    tokenHash: string;
    familyId: string;
    parentId: string | null;
    isRevoked: boolean;
    expiresAt: Date;
  }>;

  findByTokenHash(tokenHash: string): Promise<{
    id: string;
    userId: string;
    tokenHash: string;
    familyId: string;
    parentId: string | null;
    isRevoked: boolean;
    expiresAt: Date;
  } | null>;

  rotateToken(params: {
    oldTokenId: string;
    newTokenHash: string;
    familyId: string;
    userId: string;
    expiresAt: Date;
    userAgent?: string;
    ipAddress?: string;
  }): Promise<{
    id: string;
    userId: string;
    tokenHash: string;
    familyId: string;
    parentId: string | null;
    isRevoked: boolean;
    expiresAt: Date;
  }>;

  revokeToken(id: string): Promise<void>;
  revokeFamily(familyId: string): Promise<number>;
  revokeAllUserSessions(userId: string): Promise<number>;
  findActiveSessionsByUser(userId: string): Promise<
    Array<{
      id: string;
      familyId: string;
      deviceType: string | null;
      userAgent: string | null;
      ipAddress: string | null;
      lastUsedAt: Date;
      createdAt: Date;
      expiresAt: Date;
    }>
  >;
}

export interface ISecurityAuditRepository {
  logEvent(data: {
    actorId?: string;
    eventType: SecurityEventType;
    targetType?: string;
    targetId?: string;
    ipAddress?: string;
    userAgent?: string;
    metadata?: Record<string, unknown>;
  }): Promise<unknown>;

  queryEvents(params: {
    actorId?: string;
    eventType?: SecurityEventType;
    targetId?: string;
    limit?: number;
    offset?: number;
  }): Promise<unknown[]>;
}
