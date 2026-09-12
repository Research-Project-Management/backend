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

export interface IAuthnRepository {
  findUserById(id: string): Promise<User | null>;
  findUserByEmail(email: string): Promise<User | null>;
  createLocalUser(data: {
    email: string;
    passwordHash: string;
    name: string;
    avatar?: string;
  }): Promise<User>;
}
