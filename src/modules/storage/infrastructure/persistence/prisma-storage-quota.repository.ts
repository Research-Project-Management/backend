import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { IStorageQuotaRepository } from '../../domain/ports/storage-quota.repository.port';
import { StorageQuota } from '../../domain/entities/storage-quota.entity';
import { StorageQuotaMapper } from './mappers/storage-quota.mapper';

@Injectable()
export class PrismaStorageQuotaRepository implements IStorageQuotaRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByScope(
    userId?: string | null,
    projectId?: string | null,
  ): Promise<StorageQuota | null> {
    const record = await this.prisma.storageQuota.findFirst({
      where: {
        userId: userId ?? null,
        projectId: projectId ?? null,
      },
    });
    return record ? StorageQuotaMapper.toDomain(record) : null;
  }

  async upsert(quota: StorageQuota): Promise<StorageQuota> {
    const data = StorageQuotaMapper.toPrismaCreate(quota);
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
    const DEFAULT_LIMIT = 5n * 1024n * 1024n * 1024n; // 5 GB
    const existing = await this.findByScope(userId, projectId);

    if (existing) {
      const updated = await this.prisma.storageQuota.update({
        where: { id: existing.id },
        data: { usedBytes: { increment: bytes } },
      });
      return updated.usedBytes;
    }

    const created = await this.prisma.storageQuota.create({
      data: {
        userId: userId ?? null,
        projectId: projectId ?? null,
        usedBytes: bytes,
        maxBytes: DEFAULT_LIMIT,
      },
    });
    return created.usedBytes;
  }

  async decrementUsage(
    userId: string | null | undefined,
    projectId: string | null | undefined,
    bytes: bigint,
  ): Promise<bigint> {
    const quota = await this.findByScope(userId, projectId);
    if (!quota) return 0n;

    const newUsed = quota.usedBytes > bytes ? quota.usedBytes - bytes : 0n;
    const updated = await this.prisma.storageQuota.update({
      where: { id: quota.id },
      data: { usedBytes: newUsed },
    });
    return updated.usedBytes;
  }

  async reconcileUsage(
    userId: string | null | undefined,
    projectId: string | null | undefined,
    actualBytes: bigint,
  ): Promise<void> {
    const DEFAULT_LIMIT = 5n * 1024n * 1024n * 1024n;
    const existing = await this.findByScope(userId, projectId);

    if (existing) {
      await this.prisma.storageQuota.update({
        where: { id: existing.id },
        data: { usedBytes: actualBytes },
      });
    } else {
      await this.prisma.storageQuota.create({
        data: {
          userId: userId ?? null,
          projectId: projectId ?? null,
          usedBytes: actualBytes,
          maxBytes: DEFAULT_LIMIT,
        },
      });
    }
  }
}
