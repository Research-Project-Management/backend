import { Injectable } from '@nestjs/common';
import { StorageBlob as PrismaBlob } from '@prisma/client';
import { PrismaService } from '@/core';
import {
  StorageBlob,
  BlobStatus,
  ContentHash,
  StorageKey,
} from '../types';

export interface IStorageBlobRepository {
  findById(id: string): Promise<StorageBlob | null>;
  findByHash(contentHash: ContentHash): Promise<StorageBlob | null>;
  create(blob: StorageBlob): Promise<StorageBlob>;
  update(blob: StorageBlob): Promise<StorageBlob>;
  delete(id: string): Promise<void>;
  findTombstonedBlobs(threshold: Date, limit: number): Promise<StorageBlob[]>;
  incrementRefCount?(id: string): Promise<StorageBlob | null>;
  decrementRefCount?(
    id: string,
    tombstoneGraceHours?: number,
  ): Promise<StorageBlob | null>;
}

export class StorageBlobMapper {
  public static toDomain(record: PrismaBlob): StorageBlob {
    return new StorageBlob({
      id: record.id,
      contentHash: ContentHash.fromBytes(Buffer.from(record.contentHash)),
      hashAlgorithm: record.hashAlgorithm,
      sizeBytes: record.sizeBytes,
      s3Key: StorageKey.fromString(record.s3Key),
      s3Bucket: record.s3Bucket,
      storageClass: record.storageClass,
      refCount: record.refCount,
      status: record.status as BlobStatus,
      createdAt: record.createdAt,
      tombstoneAt: record.tombstoneAt,
    });
  }

  public static toPrismaCreate(blob: StorageBlob) {
    return {
      id: blob.id,
      contentHash: blob.contentHash.toBytes(),
      hashAlgorithm: blob.hashAlgorithm,
      sizeBytes: blob.sizeBytes,
      s3Key: blob.s3Key.value(),
      s3Bucket: blob.s3Bucket,
      storageClass: blob.storageClass,
      refCount: blob.refCount,
      status: blob.status,
      createdAt: blob.createdAt,
      tombstoneAt: blob.tombstoneAt,
    };
  }
}

@Injectable()
export class PrismaStorageBlobRepository implements IStorageBlobRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string): Promise<StorageBlob | null> {
    const record = await this.prisma.storageBlob.findUnique({
      where: { id },
    });
    return record ? StorageBlobMapper.toDomain(record) : null;
  }

  async findByHash(contentHash: ContentHash): Promise<StorageBlob | null> {
    const record = await this.prisma.storageBlob.findUnique({
      where: {
        contentHash: Uint8Array.from(contentHash.toBytes()),
      },
    });
    return record ? StorageBlobMapper.toDomain(record) : null;
  }

  async create(blob: StorageBlob): Promise<StorageBlob> {
    const data = StorageBlobMapper.toPrismaCreate(blob);
    const created = await this.prisma.storageBlob.create({
      data: {
        ...data,
        contentHash: Uint8Array.from(blob.contentHash.toBytes()),
      },
    });
    return StorageBlobMapper.toDomain(created);
  }

  async update(blob: StorageBlob): Promise<StorageBlob> {
    const data = StorageBlobMapper.toPrismaCreate(blob);
    const updated = await this.prisma.storageBlob.update({
      where: { id: blob.id },
      data: {
        refCount: data.refCount,
        status: data.status,
        tombstoneAt: data.tombstoneAt,
      },
    });
    return StorageBlobMapper.toDomain(updated);
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
        refCount: { lte: 0 },
        tombstoneAt: { lt: threshold },
      },
      take: limit,
    });
    return records.map((r) => StorageBlobMapper.toDomain(r));
  }

  async incrementRefCount(id: string): Promise<StorageBlob | null> {
    await this.prisma.$executeRaw`
      UPDATE storage_blobs
      SET
        ref_count = ref_count + 1,
        status = 'READY'::"BlobStatus",
        tombstone_at = NULL
      WHERE id = ${id}::uuid
    `;
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
}
