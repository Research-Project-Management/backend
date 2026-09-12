import { AuthProvider, Prisma, User } from '@prisma/client';

export type SanitizedUser = Omit<User, 'password'>;

export interface UserSettingsData {
  theme?: 'light' | 'dark' | 'system';
  language?: string;
  notifications?: {
    email?: boolean;
    inApp?: boolean;
    digest?: boolean;
  };
  preferences?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface UserStatsResult {
  projectsCount: number;
  filesCount: number;
  storageUsedBytes: number;
  storageQuotaBytes: number;
  storageUsedFormatted: string;
  stickiesCount: number;
  tasksCount: number;
  plan: string;
}

export interface FederatedIdentityLinkData {
  userId: string;
  provider: AuthProvider;
  providerSubjectId: string;
  email?: string;
  profileData?: Record<string, unknown>;
}

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
  updateUser(id: string, data: Prisma.UserUpdateInput): Promise<User>;
  softDelete(id: string): Promise<void>;
  revokeAllUserRefreshTokens(userId: string): Promise<number>;
  searchUsers(
    query: string,
    excludeUserId?: string,
    projectId?: string,
  ): Promise<Array<Pick<User, 'id' | 'name' | 'email' | 'avatar' | 'status'>>>;
  getUserSettings(userId: string): Promise<UserSettingsData>;
  updateUserSettings(
    userId: string,
    settings: Partial<UserSettingsData>,
  ): Promise<UserSettingsData>;
  getUserStats(userId: string): Promise<UserStatsResult>;
}
