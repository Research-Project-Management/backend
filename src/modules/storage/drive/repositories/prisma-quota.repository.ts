import { Injectable, BadRequestException } from '@nestjs/common';
import { StorageQuota as PrismaQuota } from '@prisma/client';
import { PrismaService } from '@/core';
import { cleanUuid } from '@/modules/storage/core';
import { StorageQuota, DEFAULT_STORAGE_QUOTA_BYTES } from '../types';

export interface IStorageQuotaRepository {
  findByScope(
    userId?: string | null,
    projectId?: string | null,
  ): Promise<StorageQuota | null>;
  incrementUsage(
    userId: string | null | undefined,
    projectId: string | null | undefined,
    bytes: bigint,
  ): Promise<bigint>;
  decrementUsage(
    userId: string | null | undefined,
    projectId: string | null | undefined,
    bytes: bigint,
  ): Promise<bigint>;
}

export class StorageQuotaMapper {
  public static toDomain(record: PrismaQuota): StorageQuota {
    return new StorageQuota({
      id: record.id,
      userId: record.userId,
      projectId: record.projectId,
      usedBytes: record.usedBytes,
      maxBytes: record.maxBytes,
      updatedAt: record.updatedAt,
    });
  }
}

@Injectable()
export class PrismaStorageQuotaRepository implements IStorageQuotaRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resolves the canonical quota scope:
   * - If projectId is provided, the quota belongs to the Project scope (userId = null, projectId = validProjectId).
   * - Otherwise, the quota belongs to the Personal Drive scope (userId = validUserId, projectId = null).
   */
  private resolveCanonicalScope(
    userId?: string | null,
    projectId?: string | null,
  ): { userId: string | null; projectId: string | null } {
    const validProjectId = cleanUuid(projectId);
    if (validProjectId) {
      return { userId: null, projectId: validProjectId };
    }
    const validUserId = cleanUuid(userId);
    return { userId: validUserId, projectId: null };
  }

  async findByScope(
    userId?: string | null,
    projectId?: string | null,
  ): Promise<StorageQuota | null> {
    const scope = this.resolveCanonicalScope(userId, projectId);
    if (!scope.userId && !scope.projectId) {
      return null;
    }

    const record = await this.prisma.storageQuota.findFirst({
      where: {
        userId: scope.userId,
        projectId: scope.projectId,
      },
      orderBy: { updatedAt: 'desc' },
    });
    return record ? StorageQuotaMapper.toDomain(record) : null;
  }

  async incrementUsage(
    userId: string | null | undefined,
    projectId: string | null | undefined,
    bytes: bigint,
  ): Promise<bigint> {
    if (bytes <= 0n) {
      const current = await this.findByScope(userId, projectId);
      return current?.usedBytes ?? 0n;
    }

    const scope = this.resolveCanonicalScope(userId, projectId);
    if (!scope.userId && !scope.projectId) {
      return 0n;
    }

    return this.prisma.$transaction(async (tx) => {
      // Advisory lock scoped to the user or project UUID to prevent NULL unique constraint duplicate creation
      const lockKey = scope.projectId ?? scope.userId!;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;

      const existing = await tx.storageQuota.findFirst({
        where: {
          userId: scope.userId,
          projectId: scope.projectId,
        },
        orderBy: { updatedAt: 'desc' },
      });

      if (existing) {
        if (existing.usedBytes + bytes > existing.maxBytes) {
          throw new BadRequestException('Storage quota exceeded');
        }
        const updated = await tx.storageQuota.update({
          where: { id: existing.id },
          data: { usedBytes: { increment: bytes } },
        });
        return updated.usedBytes;
      }

      if (bytes > DEFAULT_STORAGE_QUOTA_BYTES) {
        throw new BadRequestException('Storage quota exceeded');
      }

      const created = await tx.storageQuota.create({
        data: {
          userId: scope.userId,
          projectId: scope.projectId,
          usedBytes: bytes,
          maxBytes: DEFAULT_STORAGE_QUOTA_BYTES,
        },
      });
      return created.usedBytes;
    });
  }

  async decrementUsage(
    userId: string | null | undefined,
    projectId: string | null | undefined,
    bytes: bigint,
  ): Promise<bigint> {
    if (bytes <= 0n) {
      const current = await this.findByScope(userId, projectId);
      return current?.usedBytes ?? 0n;
    }

    const scope = this.resolveCanonicalScope(userId, projectId);
    if (!scope.userId && !scope.projectId) {
      return 0n;
    }

    return this.prisma.$transaction(async (tx) => {
      const lockKey = scope.projectId ?? scope.userId!;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;

      const quota = await tx.storageQuota.findFirst({
        where: {
          userId: scope.userId,
          projectId: scope.projectId,
        },
        orderBy: { updatedAt: 'desc' },
      });
      if (!quota) return 0n;

      const decrementAmount =
        bytes <= quota.usedBytes ? bytes : quota.usedBytes;
      if (decrementAmount <= 0n) return quota.usedBytes;

      const updated = await tx.storageQuota.update({
        where: { id: quota.id },
        data: { usedBytes: { decrement: decrementAmount } },
      });
      return updated.usedBytes;
    });
  }
}
