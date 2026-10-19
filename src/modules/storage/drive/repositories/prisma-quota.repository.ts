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

  async findByScope(
    userId?: string | null,
    projectId?: string | null,
  ): Promise<StorageQuota | null> {
    const validUserId = cleanUuid(userId);
    const validProjectId = cleanUuid(projectId);
    const record = await this.prisma.storageQuota.findFirst({
      where: {
        userId: validUserId,
        projectId: validProjectId,
      },
    });
    return record ? StorageQuotaMapper.toDomain(record) : null;
  }

  async incrementUsage(
    userId: string | null | undefined,
    projectId: string | null | undefined,
    bytes: bigint,
  ): Promise<bigint> {
    const validUserId = cleanUuid(userId);
    const validProjectId = cleanUuid(projectId);
    const existing = await this.findByScope(validUserId, validProjectId);

    if (existing) {
      if (existing.usedBytes + bytes > existing.maxBytes) {
        throw new BadRequestException('Storage quota exceeded');
      }
      const updated = await this.prisma.storageQuota.update({
        where: { id: existing.id },
        data: { usedBytes: { increment: bytes } },
      });
      return updated.usedBytes;
    }

    if (bytes > DEFAULT_STORAGE_QUOTA_BYTES) {
      throw new BadRequestException('Storage quota exceeded');
    }

    try {
      const created = await this.prisma.storageQuota.create({
        data: {
          userId: validUserId,
          projectId: validProjectId,
          usedBytes: bytes,
          maxBytes: DEFAULT_STORAGE_QUOTA_BYTES,
        },
      });
      return created.usedBytes;
    } catch (err: unknown) {
      if ((err as { code?: string })?.code === 'P2002') {
        const concurrent = await this.findByScope(validUserId, validProjectId);
        if (concurrent) {
          if (concurrent.usedBytes + bytes > concurrent.maxBytes) {
            throw new BadRequestException('Storage quota exceeded');
          }
          const updated = await this.prisma.storageQuota.update({
            where: { id: concurrent.id },
            data: { usedBytes: { increment: bytes } },
          });
          return updated.usedBytes;
        }
      }
      throw err;
    }
  }

  async decrementUsage(
    userId: string | null | undefined,
    projectId: string | null | undefined,
    bytes: bigint,
  ): Promise<bigint> {
    const validUserId = cleanUuid(userId);
    const validProjectId = cleanUuid(projectId);
    const quota = await this.findByScope(validUserId, validProjectId);
    if (!quota) return 0n;

    const decrementAmount = bytes <= quota.usedBytes ? bytes : quota.usedBytes;
    if (decrementAmount <= 0n) return quota.usedBytes;

    const updated = await this.prisma.storageQuota.update({
      where: { id: quota.id },
      data: { usedBytes: { decrement: decrementAmount } },
    });
    return updated.usedBytes;
  }
}
