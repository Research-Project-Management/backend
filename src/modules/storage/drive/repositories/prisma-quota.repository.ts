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
  upsert(quota: StorageQuota): Promise<StorageQuota>;
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
  reconcileUsage(
    userId: string | null | undefined,
    projectId: string | null | undefined,
    actualBytes: bigint,
  ): Promise<void>;
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

  public static toPrismaCreate(quota: StorageQuota) {
    return {
      id: quota.id,
      userId: quota.userId,
      projectId: quota.projectId,
      usedBytes: quota.usedBytes,
      maxBytes: quota.maxBytes,
    };
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

  async upsert(quota: StorageQuota): Promise<StorageQuota> {
    const data = StorageQuotaMapper.toPrismaCreate(quota);
    data.userId = cleanUuid(data.userId);
    data.projectId = cleanUuid(data.projectId);
    const existing = await this.findByScope(data.userId, data.projectId);

    if (existing) {
      const updated = await this.prisma.storageQuota.update({
        where: { id: existing.id },
        data: {
          maxBytes: data.maxBytes,
          usedBytes: data.usedBytes,
        },
      });
      return StorageQuotaMapper.toDomain(updated);
    }

    const created = await this.prisma.storageQuota.create({ data });
    return StorageQuotaMapper.toDomain(created);
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

    const created = await this.prisma.storageQuota.create({
      data: {
        userId: validUserId,
        projectId: validProjectId,
        usedBytes: bytes,
        maxBytes: DEFAULT_STORAGE_QUOTA_BYTES,
      },
    });
    return created.usedBytes;
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

  async reconcileUsage(
    userId: string | null | undefined,
    projectId: string | null | undefined,
    actualBytes: bigint,
  ): Promise<void> {
    const validUserId = cleanUuid(userId);
    const validProjectId = cleanUuid(projectId);
    const existing = await this.findByScope(validUserId, validProjectId);

    if (existing) {
      await this.prisma.storageQuota.update({
        where: { id: existing.id },
        data: { usedBytes: actualBytes },
      });
    } else {
      await this.prisma.storageQuota.create({
        data: {
          userId: validUserId,
          projectId: validProjectId,
          usedBytes: actualBytes,
          maxBytes: DEFAULT_STORAGE_QUOTA_BYTES,
        },
      });
    }
  }
}
