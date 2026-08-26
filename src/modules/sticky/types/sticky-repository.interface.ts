/**
 * Sticky Domain Repository Interface (Port)
 *
 * Implements Hexagonal / DDD-Lite Architecture decoupling Prisma models from services.
 */

import { Sticky, StickyScope, Prisma } from '@prisma/client';

export const USER_MINIMAL_SELECT = {
  id: true,
  name: true,
  email: true,
  avatar: true,
} as const;

export type StickyWithUser = Prisma.StickyGetPayload<{
  include: {
    user: { select: typeof USER_MINIMAL_SELECT };
  };
}>;

export interface IStickyRepository {
  findStickyById(stickyId: string): Promise<StickyWithUser | null>;
  findWorkspaceStickies(
    workspaceId: string,
    userId: string,
  ): Promise<StickyWithUser[]>;
  findProjectStickies(
    projectId: string,
    userId: string,
  ): Promise<StickyWithUser[]>;
  countWorkspaceStickies(workspaceId: string, userId: string): Promise<number>;
  countProjectStickies(projectId: string, userId: string): Promise<number>;
  createSticky(
    data: Prisma.StickyCreateInput | Prisma.StickyUncheckedCreateInput,
  ): Promise<StickyWithUser>;
  updateSticky(
    stickyId: string,
    data: Prisma.StickyUpdateInput | Prisma.StickyUncheckedUpdateInput,
  ): Promise<StickyWithUser>;
  deleteSticky(stickyId: string): Promise<Sticky>;
  reorderStickies(stickyIds: string[]): Promise<Sticky[]>;
  findProjectWorkspaceId(projectId: string): Promise<string | null>;
  resolveWorkspace(workspaceIdOrSlug: string): Promise<{ id: string } | null>;
}
