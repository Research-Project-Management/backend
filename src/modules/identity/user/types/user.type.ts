import {
  AuthProvider,
  Prisma,
  ThemePreference,
  User,
  UserProfile,
} from '@prisma/client';

export type UserWithProfile = User & { profile?: UserProfile | null };

export type SanitizedUser = Omit<User, 'password'> & {
  name: string;
  avatar: string | null;
  profile?: UserProfile | null;
};

/**
 * Strict Domain Model for User Settings (Read/Output).
 * Guaranteed non-null fields governed by database invariants and schema defaults.
 */
export interface UserSettingsEntity {
  theme: ThemePreference;
  locale: string;
  editorConfig: Prisma.JsonValue;
}

/**
 * Mutation payload for updating settings (Write/PATCH).
 * Fields are legitimately optional as clients submit partial modifications.
 */
export interface UpdateUserSettingsInput {
  theme?: ThemePreference | 'light' | 'dark' | 'system';
  locale?: string;
  editorConfig?: Prisma.InputJsonValue;
  [key: string]: unknown;
}

export type UserSettingsData = UserSettingsEntity;

export interface UserStatsResult {
  projectsCount: number;
  filesCount: number;
  storageUsedBytes: number;
  storageQuotaBytes: number;
  storageUsedFormatted: string;
  stickiesCount: number;
  workItemsCount: number;
  plan: string;
}

export interface FederatedIdentityLinkData {
  userId: string;
  provider: AuthProvider;
  providerSubjectId: string;
  email?: string;
  profileData?: Record<string, unknown>;
}

export interface OwnedProjectInfo {
  id: string;
  name: string;
  identifier: string;
  isArchived: boolean;
  memberCount: number;
}

export interface IUserRepository {
  findById(id: string): Promise<UserWithProfile | null>;
  findByEmail(email: string): Promise<UserWithProfile | null>;
  createWithLocalAuth(data: {
    email: string;
    passwordHash: string;
    name: string;
    avatar?: string;
  }): Promise<UserWithProfile>;
  updateProfile(
    id: string,
    data: {
      name?: string;
      avatar?: string | null;
      institution?: string | null;
    },
  ): Promise<UserWithProfile>;
  updateUser(id: string, data: Prisma.UserUpdateInput): Promise<User>;
  softDelete(id: string): Promise<void>;
  deactivateAccount(id: string): Promise<void>;
  revokeAllUserRefreshTokens(userId: string): Promise<number>;
  searchUsers(
    query: string,
    excludeUserId?: string,
    projectId?: string,
  ): Promise<
    Array<{
      id: string;
      name: string;
      email: string;
      avatar: string | null;
      status: User['status'];
    }>
  >;
  findOwnedProjects(userId: string): Promise<OwnedProjectInfo[]>;
  archiveProjects(projectIds: string[]): Promise<number>;
  getUserSettings(userId: string): Promise<UserSettingsEntity>;
  updateUserSettings(
    userId: string,
    settings: UpdateUserSettingsInput,
  ): Promise<UserSettingsEntity>;
  getUserStats(userId: string): Promise<UserStatsResult>;
  findByProviderSubject(
    provider: AuthProvider,
    subjectId: string,
  ): Promise<{
    id: string;
    userId: string;
    provider: AuthProvider;
    providerSubjectId: string;
    email: string | null;
    profileData: unknown;
    user: User & { profile?: { name: string; avatar: string | null } | null };
  } | null>;
  findAccountsByUserId(userId: string): Promise<
    Array<{
      id: string;
      userId: string;
      provider: string;
      providerSubjectId: string;
      email: string | null;
    }>
  >;
  linkAccount(data: {
    userId: string;
    provider: AuthProvider;
    providerSubjectId: string;
    email?: string;
    profileData?: Record<string, unknown>;
  }): Promise<unknown>;
  unlinkAccount(userId: string, provider: AuthProvider): Promise<void>;
}
