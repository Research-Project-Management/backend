import { StorageQuota } from '../entities/storage-quota.entity';

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
