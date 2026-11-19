import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core';
import { ContentHash, StorageBlob } from '../domain/blob.domain';
import { BlobMapper } from '../domain/files.mapper';

export interface IBlobRepository {
  findById(id: string): Promise<StorageBlob | null>;
  findByHash(contentHash: ContentHash): Promise<StorageBlob | null>;
  create(blob: StorageBlob): Promise<StorageBlob>;
  delete(id: string): Promise<void>;
  findTombstonedBlobs(threshold: Date, limit: number): Promise<StorageBlob[]>;
  incrementRefCount(id: string): Promise<StorageBlob | null>;
  decrementRefCount(
    id: string,
    tombstoneGraceHours?: number,
  ): Promise<StorageBlob | null>;
  claimBlobForPurge?(id: string, threshold: Date): Promise<boolean>;
  restoreClaimedBlob?(id: string): Promise<void>;
}

@Injectable()
export class BlobRepository implements IBlobRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string): Promise<StorageBlob | null> {
    const record = await this.prisma.storageBlob.findUnique({
      where: { id },
    });
    return record ? BlobMapper.toDomain(record) : null;
  }

  async findByHash(contentHash: ContentHash): Promise<StorageBlob | null> {
    const record = await this.prisma.storageBlob.findUnique({
      where: {
        contentHash: Uint8Array.from(contentHash.toBytes()),
      },
    });
    return record ? BlobMapper.toDomain(record) : null;
  }

  async create(blob: StorageBlob): Promise<StorageBlob> {
    const data = BlobMapper.toPrismaCreate(blob);
    const created = await this.prisma.storageBlob.create({
      data: {
        ...data,
        contentHash: Uint8Array.from(blob.contentHash.toBytes()),
      },
    });
    return BlobMapper.toDomain(created);
  }

  async delete(id: string): Promise<void> {
    await this.prisma.storageBlob.delete({
      where: { id },
    });
  }

  async findTombstonedBlobs(
    threshold: Date,
    limit: number,
  ): Promise<StorageBlob[]> {
    const records = await this.prisma.storageBlob.findMany({
      where: {
        refCount: 0,
        status: 'DELETED',
        tombstoneAt: { lt: threshold },
      },
      take: limit,
    });
    return records.map((r) => BlobMapper.toDomain(r));
  }

  async incrementRefCount(id: string): Promise<StorageBlob | null> {
    const affected = await this.prisma.$executeRaw`
      UPDATE storage_blobs
      SET
        ref_count = ref_count + 1,
        status = 'READY'::"BlobStatus",
        tombstone_at = NULL
      WHERE id = ${id}::uuid AND ref_count >= 0
    `;
    if (Number(affected) === 0) {
      return null;
    }
    return this.findById(id);
  }

  async decrementRefCount(
    id: string,
    tombstoneGraceHours = 48,
  ): Promise<StorageBlob | null> {
    const tombstoneAt = new Date(
      Date.now() + tombstoneGraceHours * 3600 * 1000,
    );
    await this.prisma.$executeRaw`
      UPDATE storage_blobs
      SET
        ref_count = GREATEST(0, ref_count - 1),
        status = CASE WHEN ref_count - 1 <= 0 THEN 'DELETED'::"BlobStatus" ELSE status END,
        tombstone_at = CASE WHEN ref_count - 1 <= 0 THEN ${tombstoneAt} ELSE tombstone_at END
      WHERE id = ${id}::uuid
    `;
    return this.findById(id);
  }

  async claimBlobForPurge(id: string, threshold: Date): Promise<boolean> {
    const affected = await this.prisma.$executeRaw`
      UPDATE storage_blobs
      SET ref_count = -1
      WHERE id = ${id}::uuid
        AND ref_count = 0
        AND status = 'DELETED'::"BlobStatus"
        AND tombstone_at < ${threshold}
        AND NOT EXISTS (SELECT 1 FROM storage_files sf WHERE sf.blob_id = ${id}::uuid)
        AND NOT EXISTS (SELECT 1 FROM storage_file_versions sv WHERE sv.blob_id = ${id}::uuid)
        AND NOT EXISTS (SELECT 1 FROM page_files pf WHERE pf.blob_id = ${id}::uuid)
    `;
    return Number(affected) > 0;
  }

  async restoreClaimedBlob(id: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE storage_blobs
      SET ref_count = 0
      WHERE id = ${id}::uuid AND ref_count = -1
    `;
  }
}
