import {
  AuthProvider,
  CitationStyle,
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
  citationStyle: CitationStyle;
  locale: string;
  editorConfig: Prisma.JsonValue;
  notifications: Record<string, unknown>;
  aiPreferences: Prisma.JsonValue;
}

/**
 * Mutation payload for updating settings (Write/PATCH).
 * Fields are legitimately optional as clients submit partial modifications.
 */
export interface UpdateUserSettingsInput {
  theme?: ThemePreference | 'light' | 'dark' | 'system';
  citationStyle?: CitationStyle;
  locale?: string;
  editorConfig?: Prisma.InputJsonValue;
  notifications?: Prisma.InputJsonValue;
  aiPreferences?: Prisma.InputJsonValue;
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
      bio?: string | null;
      institution?: string | null;
      department?: string | null;
      academicTitle?: string | null;
      orcidId?: string | null;
      website?: string | null;
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
}
