import { UploadSession as PrismaSession } from '@prisma/client';
import {
  UploadSession,
  UploadSessionStatus,
} from '../../../domain/entities/upload-session.entity';
import { FileScope } from '../../../domain/value-objects/file-scope.vo';

export class UploadSessionMapper {
  public static toDomain(record: PrismaSession): UploadSession {
    return new UploadSession({
      id: record.id,
      projectId: record.projectId,
      userId: record.userId,
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
      scope: (record.linkedToType as FileScope) || FileScope.Personal,
      status: record.status as UploadSessionStatus,
      expiresAt: record.expiresAt,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
  }

  public static toPrismaCreate(session: UploadSession) {
    return {
      id: session.id,
      projectId: session.projectId,
      userId: session.userId,
      s3UploadId: session.s3UploadId,
      s3Key: session.s3Key,
      filename: session.filename,
      mimeType: session.mimeType,
      totalSize: session.totalSize,
      partSize: session.partSize,
      totalParts: session.totalParts,
      expectedHash: session.expectedHash,
      parentId: session.parentId,
      linkedToType: session.scope,
      linkedToId: session.projectId,
      status: session.status,
      expiresAt: session.expiresAt,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    };
  }
}
