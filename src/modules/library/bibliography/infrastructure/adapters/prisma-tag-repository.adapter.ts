import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../../core/database/prisma.service';
import {
  ITagRepositoryPort,
  TagDto,
  FindTagsOptions,
  CreateTagOptions,
} from '../../domain/ports/tag-repository.port';

/**
 * Infrastructure Adapter — implements ITagRepositoryPort using Prisma.
 *
 * This is an OUTBOUND / DRIVEN adapter (right-side hexagon).
 * It translates domain-level tag operations into Prisma DB calls.
 * The Application layer never imports this class directly — it depends
 * only on the ITagRepositoryPort interface (Dependency Inversion).
 */
@Injectable()
export class PrismaTagRepositoryAdapter implements ITagRepositoryPort {
  constructor(private readonly prisma: PrismaService) {}

  async findMany(userId: string, options?: FindTagsOptions): Promise<TagDto[]> {
    const where =
      options?.projectId && options.projectId !== 'user'
        ? {
            projectId: options.projectId,
            ...(options?.includeInactive
              ? {}
              : {
                  itemTags: {
                    some: { item: { deletedAt: null } },
                  },
                }),
          }
        : {
            userId,
            ...(options?.includeInactive
              ? {}
              : {
                  itemTags: {
                    some: { item: { deletedAt: null } },
                  },
                }),
          };

    const rows = await this.prisma.tag.findMany({
      where,
      orderBy: { name: 'asc' },
      include: {
        _count: {
          select: {
            itemTags: { where: { item: { deletedAt: null } } },
          },
        },
      },
    });

    return rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      projectId: r.projectId,
      name: r.name,
      color: r.color ?? '#3b82f6',
      type: r.type ?? 'manual',
      createdAt: r.createdAt,
      _count: r._count,
    }));
  }

  async findByName(userId: string, name: string): Promise<TagDto | null> {
    const row = await this.prisma.tag.findFirst({ where: { userId, name } });
    if (!row) return null;
    return {
      id: row.id,
      userId: row.userId,
      projectId: row.projectId,
      name: row.name,
      color: row.color ?? '#3b82f6',
      type: row.type ?? 'manual',
      createdAt: row.createdAt,
    };
  }

  async createOrGet(
    userId: string,
    name: string,
    options?: CreateTagOptions,
  ): Promise<TagDto> {
    const color = options?.color ?? '#3b82f6';
    const type = options?.type ?? 'manual';
    const effectiveProjectId =
      options?.projectId &&
      options.projectId !== 'user' &&
      options.projectId !== 'me' &&
      options.projectId !== 'personal'
        ? options.projectId
        : undefined;

    let row: any;

    if (effectiveProjectId) {
      const existing = await this.prisma.tag.findFirst({
        where: { projectId: effectiveProjectId, name },
      });
      if (existing) {
        if (color && existing.color !== color) {
          row = await this.prisma.tag.update({
            where: { id: existing.id },
            data: { color },
          });
        } else {
          row = existing;
        }
      } else {
        row = await this.prisma.tag.create({
          data: { userId, name, color, type, projectId: effectiveProjectId },
        });
      }
    } else {
      row = await this.prisma.tag.upsert({
        where: { userId_name: { userId, name } },
        create: { userId, name, color, type },
        update: { color },
      });
    }

    return {
      id: row.id,
      userId: row.userId,
      projectId: row.projectId,
      name: row.name,
      color: row.color,
      type: row.type,
      createdAt: row.createdAt,
    };
  }

  async delete(userId: string, tagId: string): Promise<boolean> {
    const result = await this.prisma.tag.deleteMany({
      where: { id: tagId, userId },
    });
    return result.count > 0;
  }

  async assignToItem(tagId: string, itemId: string): Promise<void> {
    await this.prisma.itemTag.upsert({
      where: { tagId_itemId: { tagId, itemId } },
      create: { tagId, itemId },
      update: {},
    });
  }

  async removeFromItem(tagId: string, itemId: string): Promise<void> {
    await this.prisma.itemTag.deleteMany({ where: { tagId, itemId } });
  }
}
