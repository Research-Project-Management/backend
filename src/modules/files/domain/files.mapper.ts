import {
  StorageBlob as PrismaBlob,
  StorageQuota as PrismaQuota,
  UploadSession as PrismaSession,
} from '@prisma/client';
import {
  BlobStatus,
  ContentHash,
  StorageBlob,
  StorageKey,
} from './blob.domain';
import { StorageQuota } from './quota.domain';
import { UploadSession, UploadSessionStatus } from './session.domain';

export class BlobMapper {
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

export class QuotaMapper {
  public static toDomain(record: PrismaQuota): StorageQuota {
    return new StorageQuota({
      id: record.id,
      spaceId: record.spaceId,
      usedBytes: record.usedBytes,
      maxBytes: record.maxBytes,
      updatedAt: record.updatedAt,
    });
  }
}

export class SessionMapper {
  public static toDomain(record: PrismaSession): UploadSession {
    const isSharedSpace = Boolean(
      record.spaceId && record.spaceId !== record.createdById,
    );
    return new UploadSession({
      id: record.id,
      spaceId: record.spaceId,
      userId: record.createdById,
      s3UploadId: record.s3UploadId,
      s3Key: record.s3Key,
      filename: record.filename,
      mimeType: record.mimeType,
      totalSize: record.totalSize,
      partSize: record.partSize,
      totalParts: record.totalParts,
      expectedHash: record.expectedHash
        ? Buffer.from(record.expectedHash)
        : null,
      parentId: record.parentId,
      scope: isSharedSpace ? 'Project' : 'Personal',
      status: record.status as UploadSessionStatus,
      expiresAt: record.expiresAt,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
  }

  public static toPrismaCreate(session: UploadSession) {
    return {
      id: session.id,
      spaceId: session.spaceId || session.userId,
      createdById: session.userId,
      s3UploadId: session.s3UploadId,
      s3Key: session.s3Key,
      filename: session.filename,
      mimeType: session.mimeType,
      totalSize: session.totalSize,
      partSize: session.partSize,
      totalParts: session.totalParts,
      expectedHash: session.expectedHash,
      parentId: session.parentId,
      status: session.status,
      expiresAt: session.expiresAt,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    };
  }
}
