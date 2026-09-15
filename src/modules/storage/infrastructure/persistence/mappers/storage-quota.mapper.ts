import { StorageQuota as PrismaQuota } from '@prisma/client';
import { StorageQuota } from '../../../domain/entities/storage-quota.entity';

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
