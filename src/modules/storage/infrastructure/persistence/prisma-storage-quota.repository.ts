import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { IStorageQuotaRepository } from '../../domain/ports/storage-quota.repository.port';
import { StorageQuota } from '../../domain/entities/storage-quota.entity';
import { StorageQuotaMapper } from './mappers/storage-quota.mapper';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cleanUuid(id?: string | null): string | null {
  if (!id || typeof id !== 'string') return null;
  const trimmed = id.trim();
  return UUID_REGEX.test(trimmed) ? trimmed : null;
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
    const DEFAULT_LIMIT = 5n * 1024n * 1024n * 1024n; // 5 GB
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

    if (bytes > DEFAULT_LIMIT) {
      throw new BadRequestException('Storage quota exceeded');
    }

    const created = await this.prisma.storageQuota.create({
      data: {
        userId: validUserId,
        projectId: validProjectId,
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
    const validUserId = cleanUuid(userId);
    const validProjectId = cleanUuid(projectId);
    const quota = await this.findByScope(validUserId, validProjectId);
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
          maxBytes: DEFAULT_LIMIT,
        },
      });
    }
  }
}
