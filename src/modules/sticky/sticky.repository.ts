import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { isUUID } from 'class-validator';
import { Prisma, Sticky } from '@prisma/client';
import {
  IStickyRepository,
  StickyWithUser,
  USER_MINIMAL_SELECT,
} from './types/sticky-repository.interface';

export type { StickyWithUser };

@Injectable()
export class StickyRepository implements IStickyRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findStickyById(stickyId: string): Promise<StickyWithUser | null> {
    if (!isUUID(stickyId)) return null;
    return this.prisma.sticky.findUnique({
      where: { id: stickyId },
      include: {
        user: { select: USER_MINIMAL_SELECT },
      },
    });
  }

  async findStickiesByUserId(userId: string): Promise<StickyWithUser[]> {
    if (!isUUID(userId)) return [];
    return this.prisma.sticky.findMany({
      where: { userId },
      include: {
        user: { select: USER_MINIMAL_SELECT },
      },
      orderBy: { order: 'asc' },
    });
  }

  async findPersonalStickies(userId: string): Promise<StickyWithUser[]> {
    return this.findStickiesByUserId(userId);
  }

  async countStickiesByUserId(userId: string): Promise<number> {
    if (!isUUID(userId)) return 0;
    return this.prisma.sticky.count({
      where: { userId },
    });
  }

  async countPersonalStickies(userId: string): Promise<number> {
    return this.countStickiesByUserId(userId);
  }

  async findStickiesByProjectId(projectId: string): Promise<StickyWithUser[]> {
    if (!isUUID(projectId)) return [];
    return this.prisma.sticky.findMany({
      where: { projectId },
      include: {
        user: { select: USER_MINIMAL_SELECT },
      },
      orderBy: { order: 'asc' },
    });
  }

  async countStickiesByProjectId(projectId: string): Promise<number> {
    if (!isUUID(projectId)) return 0;
    return this.prisma.sticky.count({
      where: { projectId },
    });
  }

  async createSticky(
    data: Prisma.StickyCreateInput | Prisma.StickyUncheckedCreateInput,
  ): Promise<StickyWithUser> {
    return this.prisma.sticky.create({
      data: data as Prisma.StickyCreateInput,
      include: {
        user: { select: USER_MINIMAL_SELECT },
      },
    });
  }

  async updateSticky(
    stickyId: string,
    data: Prisma.StickyUpdateInput | Prisma.StickyUncheckedUpdateInput,
  ): Promise<StickyWithUser> {
    return this.prisma.sticky.update({
      where: { id: stickyId },
      data: data,
      include: {
        user: { select: USER_MINIMAL_SELECT },
      },
    });
  }

  async deleteSticky(stickyId: string): Promise<Sticky> {
    return this.prisma.sticky.delete({
      where: { id: stickyId },
    });
  }

  async findStickiesByIds(stickyIds: string[]): Promise<Sticky[]> {
    const validIds = stickyIds.filter((id) => isUUID(id));
    if (validIds.length === 0) return [];
    return this.prisma.sticky.findMany({
      where: { id: { in: validIds } },
    });
  }

  async reorderStickies(stickyIds: string[]): Promise<Sticky[]> {
    const validIds = stickyIds.filter((id) => isUUID(id));
    if (validIds.length === 0) return [];
    const updates = validIds.map((id, index) =>
      this.prisma.sticky.update({
        where: { id },
        data: { order: index },
      }),
    );
    return this.prisma.$transaction(updates);
  }
}
