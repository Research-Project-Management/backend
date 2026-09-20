import { User, AuthProvider } from '@prisma/client';

export interface AuthSessionTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
}

export interface JwtTokenPayload {
  readonly sub: string;
  readonly email: string;
  readonly iat?: number;
  readonly exp?: number;
}

export interface FederatedProfile {
  readonly provider: AuthProvider;
  readonly providerSubjectId: string;
  readonly email: string;
  readonly name?: string;
  readonly avatar?: string;
  readonly profileData?: Record<string, unknown>;
}

export interface AuthSuccessPayload {
  readonly user: User;
  readonly tokens: AuthSessionTokens;
}

export interface IAuthRepository {
  findUserById(id: string): Promise<User | null>;
  findUserByEmail(email: string): Promise<User | null>;
  createLocalUser(data: {
    email: string;
    passwordHash: string;
    name: string;
    avatar?: string;
  }): Promise<User>;
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
