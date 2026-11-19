import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '@/core';
import { DEFAULT_STORAGE_QUOTA_BYTES } from '../files.constant';
import { StorageQuota } from '../domain/quota.domain';
import { cleanUuid } from '../domain/files.policy';
import { QuotaMapper } from '../domain/files.mapper';

export interface IQuotaRepository {
  findBySpaceId(spaceId: string): Promise<StorageQuota | null>;
  incrementUsage(spaceId: string, bytes: bigint): Promise<bigint>;
  decrementUsage(spaceId: string, bytes: bigint): Promise<bigint>;
}

@Injectable()
export class QuotaRepository implements IQuotaRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findBySpaceId(spaceId: string): Promise<StorageQuota | null> {
    const validSpaceId = cleanUuid(spaceId);
    if (!validSpaceId) {
      return null;
    }

    const record = await this.prisma.storageQuota.findUnique({
      where: {
        spaceId: validSpaceId,
      },
    });
    return record ? QuotaMapper.toDomain(record) : null;
  }

  async incrementUsage(spaceId: string, bytes: bigint): Promise<bigint> {
    if (bytes <= 0n) {
      const current = await this.findBySpaceId(spaceId);
      return current?.usedBytes ?? 0n;
    }

    const validSpaceId = cleanUuid(spaceId);
    if (!validSpaceId) {
      return 0n;
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${validSpaceId}))`;

      const existing = await tx.storageQuota.findUnique({
        where: {
          spaceId: validSpaceId,
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
          spaceId: validSpaceId,
          usedBytes: bytes,
          maxBytes: DEFAULT_STORAGE_QUOTA_BYTES,
        },
      });
      return created.usedBytes;
    });
  }

  async decrementUsage(spaceId: string, bytes: bigint): Promise<bigint> {
    if (bytes <= 0n) {
      const current = await this.findBySpaceId(spaceId);
      return current?.usedBytes ?? 0n;
    }

    const validSpaceId = cleanUuid(spaceId);
    if (!validSpaceId) {
      return 0n;
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${validSpaceId}))`;

      const quota = await tx.storageQuota.findUnique({
        where: {
          spaceId: validSpaceId,
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
