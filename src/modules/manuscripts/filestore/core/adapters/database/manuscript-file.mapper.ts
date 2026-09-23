/**
 * filestore/core/adapters/database/manuscript-file.mapper.ts
 * Mapper converting between Prisma ManuscriptFile rows and Domain ManuscriptFile Entities.
 */

import { ManuscriptFile as PrismaManuscriptFile } from '@prisma/client';
import { ManuscriptFile } from '../../domain/entities/manuscript-file.entity';
import { ContentHash } from '../../domain/value-objects/content-hash.vo';
import { StorageKey } from '../../domain/value-objects/storage-key.vo';

export class ManuscriptFileMapper {
  public static toDomain(row: PrismaManuscriptFile): ManuscriptFile {
    return ManuscriptFile.reconstitute({
      id: row.id,
      projectId: row.projectId,
      name: row.name,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      hash: ContentHash.create(row.hash),
      storageKey: StorageKey.fromRawKey(row.storageKey),
      bucketName: row.bucketName,
      rev: row.rev,
      deleted: row.deleted,
      deletedAt: row.deletedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }

  public static toPersistence(entity: ManuscriptFile): {
    id: string;
    projectId: string;
    name: string;
    mimeType: string;
    sizeBytes: number;
    hash: string;
    storageKey: string;
    bucketName: string;
    rev: number;
    deleted: boolean;
    deletedAt: Date | null;
  } {
    return {
      id: entity.id,
      projectId: entity.projectId,
      name: entity.name,
      mimeType: entity.mimeType,
      sizeBytes: entity.sizeBytes,
      hash: entity.hash.getValue(),
      storageKey: entity.storageKey.getValue(),
      bucketName: entity.bucketName,
      rev: entity.rev,
      deleted: entity.deleted,
      deletedAt: entity.deletedAt,
    };
  }
}
