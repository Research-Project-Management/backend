import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '@/core';
import { DEFAULT_STORAGE_QUOTA_BYTES } from '../files.constant';
import { StorageQuota } from '../domain/quota.domain';
import { cleanUuid } from '../domain/files.policy';
import { QuotaMapper } from '../domain/files.mapper';

export interface IQuotaRepository {
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

@Injectable()
export class QuotaRepository implements IQuotaRepository {
  constructor(private readonly prisma: PrismaService) {}

  private resolveCanonicalScope(
    userId?: string | null,
    projectId?: string | null,
  ): {
    spaceId: string | null;
    userId: string | null;
    projectId: string | null;
  } {
    const validProjectId = cleanUuid(projectId);
    if (validProjectId) {
      return {
        spaceId: validProjectId,
        userId: null,
        projectId: validProjectId,
      };
    }
    const validUserId = cleanUuid(userId);
    return {
      spaceId: validUserId,
      userId: validUserId,
      projectId: null,
    };
  }

  async findByScope(
    userId?: string | null,
    projectId?: string | null,
  ): Promise<StorageQuota | null> {
    const scope = this.resolveCanonicalScope(userId, projectId);
    if (!scope.spaceId) {
      return null;
    }

    const record = await this.prisma.storageQuota.findUnique({
      where: {
        spaceId: scope.spaceId,
      },
    });
    return record ? QuotaMapper.toDomain(record, scope) : null;
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
    if (!scope.spaceId) {
      return 0n;
    }
    const spaceId = scope.spaceId;

    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${spaceId}))`;

      const existing = await tx.storageQuota.findUnique({
        where: {
          spaceId,
        },
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
          spaceId,
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
    if (!scope.spaceId) {
      return 0n;
    }
    const spaceId = scope.spaceId;

    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${spaceId}))`;

      const quota = await tx.storageQuota.findUnique({
        where: {
          spaceId,
        },
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
