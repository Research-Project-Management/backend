import { StorageBlob as PrismaBlob } from '@prisma/client';
import {
  StorageBlob,
  BlobStatus,
} from '../../../domain/entities/storage-blob.entity';
import { ContentHash } from '../../../domain/value-objects/content-hash.vo';
import { StorageKey } from '../../../domain/value-objects/storage-key.vo';

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
