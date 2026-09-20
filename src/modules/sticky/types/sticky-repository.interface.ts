/**
 * Sticky Domain Repository Interface (Port)
 *
 * Standardized for Project & Personal Scopes (no workspace).
 */

import { Sticky, Prisma } from '@prisma/client';

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

export type StickyWithUser = Prisma.StickyGetPayload<{
  include: {
    user: { select: typeof USER_MINIMAL_SELECT };
  };
}>;

export interface IStickyRepository {
  findStickyById(stickyId: string): Promise<StickyWithUser | null>;
  findStickiesByUserId(
    userId: string,
    search?: string,
  ): Promise<StickyWithUser[]>;
  countStickiesByUserId(userId: string): Promise<number>;
  createSticky(
    data: Prisma.StickyCreateInput | Prisma.StickyUncheckedCreateInput,
  ): Promise<StickyWithUser>;
  updateSticky(
    stickyId: string,
    data: Prisma.StickyUpdateInput | Prisma.StickyUncheckedUpdateInput,
  ): Promise<StickyWithUser>;
  deleteSticky(stickyId: string): Promise<Sticky>;
  findStickiesByIds(stickyIds: string[]): Promise<Sticky[]>;
  reorderStickies(stickyIds: string[]): Promise<Sticky[]>;
}
