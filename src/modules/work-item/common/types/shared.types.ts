/**
 * Common Minimal Projection Selections & Interfaces
 * Shared across work-item submodules to avoid leaky abstractions across domains.
 */

export const USER_MINIMAL_SELECT = {
  id: true,
  email: true,
  profile: {
    select: {
      name: true,
      avatar: true,
    },
  },
} as const;

export interface UserMinimal {
  id: string;
  name: string | null;
  email: string | null;
  avatar: string | null;
}
