import { User, UserProfile } from '@prisma/client';
import { SanitizedUser } from '../types/user.type';

export function sanitizeUser(
  user: (User & { profile?: UserProfile | null }) | null | undefined,
): SanitizedUser | null {
  if (!user) return null;
  const { password: _password, profile, ...rest } = user;
  return {
    ...rest,
    name: profile?.name ?? 'User',
    avatar: profile?.avatar ?? null,
    profile: profile ?? null,
  };
}

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 MB';
  const megabytes = bytes / (1024 * 1024);
  if (megabytes < 1024) {
    return `${megabytes.toFixed(2)} MB`;
  }
  const gigabytes = megabytes / 1024;
  return `${gigabytes.toFixed(2)} GB`;
}
