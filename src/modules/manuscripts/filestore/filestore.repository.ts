/**
 * filestore/filestore.repository.ts
 * Direct @Injectable() Repository for Manuscripts Filestore.
 *
 * Encapsulates:
 * - PostgreSQL metadata persistence via Prisma
 * - Physical binary storage seam (Local Disk vs S3/MinIO/R2/Tigris)
 * - Git-blob Content-Addressable Storage (CAS) stream hashing
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Readable } from 'node:stream';
import { PrismaService } from '@/core';
import { IManuscriptFileRepository } from './core/ports/manuscript-file-repository.port';
import {
  IBinaryStoragePort,
  StorageObjectMetadata,
  StorageRangeOptions,
  StorageUploadOptions,
} from './core/ports/binary-storage.port';
import { StreamHashResult } from './core/ports/content-hasher.port';
import { ManuscriptFile } from './core/domain/entities/manuscript-file.entity';
import { ContentHash } from './core/domain/value-objects/content-hash.vo';
import { StorageKey } from './core/domain/value-objects/storage-key.vo';
import { ManuscriptFileMapper } from './core/adapters/database/manuscript-file.mapper';
import { LocalDiskBinaryStorageAdapter } from './core/adapters/storage/local-disk-binary-storage.adapter';
import { S3BinaryStorageAdapter } from './core/adapters/storage/s3-binary-storage.adapter';
import { CryptoGitBlobHasherAdapter } from './core/adapters/engine/crypto-git-blob-hasher.adapter';

@Injectable()
export class FilestoreRepository extends IManuscriptFileRepository {
  private readonly logger = new Logger(FilestoreRepository.name);
  private readonly storage: IBinaryStoragePort;
  private readonly hasher: CryptoGitBlobHasherAdapter;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() configService?: ConfigService,
    @Optional() storageOverride?: IBinaryStoragePort,
    @Optional() hasherOverride?: CryptoGitBlobHasherAdapter,
  ) {
    super();
    this.hasher = hasherOverride ?? new CryptoGitBlobHasherAdapter();
    if (storageOverride) {
      this.storage = storageOverride;
    } else if (configService) {
      const s3Key = configService.get<string>('AWS_ACCESS_KEY_ID');
      const s3Endpoint = configService.get<string>('AWS_ENDPOINT');
      const forceLocal =
        configService.get<string>('MANUSCRIPTS_FILESTORE_DRIVER') === 'local';

      this.storage =
        forceLocal || (!s3Key && !s3Endpoint)
          ? new LocalDiskBinaryStorageAdapter()
          : new S3BinaryStorageAdapter(configService);
    } else {
      this.storage = new LocalDiskBinaryStorageAdapter();
    }
  }

  // ─── CAS Hashing ────────────────────────────────────────────────────────────

  public async hashStream(stream: Readable): Promise<StreamHashResult> {
    return this.hasher.hashStream(stream);
  }

  public hashBuffer(buffer: Buffer): StreamHashResult {
    return this.hasher.hashBuffer(buffer);
  }

  public buildStorageKey(hash: ContentHash, prefix = 'blobs'): StorageKey {
    return this.hasher.buildStorageKey(hash, prefix);
  }

  // ─── Binary Storage Operations (Local Disk / S3) ────────────────────────────

  public async sendStream(
    bucket: string,
    key: string,
    stream: Readable,
    options?: StorageUploadOptions,
  ): Promise<void> {
    return this.storage.sendStream(bucket, key, stream, options);
  }

  public async getObjectStream(
    bucket: string,
    key: string,
    range?: StorageRangeOptions,
  ): Promise<Readable> {
    return this.storage.getObjectStream(bucket, key, range);
  }

  public async getObjectMetadata(
    bucket: string,
    key: string,
  ): Promise<StorageObjectMetadata> {
    return this.storage.getObjectMetadata(bucket, key);
  }

  public async getSignedDownloadUrl(
    bucket: string,
    key: string,
    expiresInSeconds: number,
  ): Promise<string | null> {
    return this.storage.getSignedDownloadUrl(bucket, key, expiresInSeconds);
  }

  public async checkObjectExists(
    bucket: string,
    key: string,
  ): Promise<boolean> {
    return this.storage.checkObjectExists(bucket, key);
  }

  public async deleteObject(bucket: string, key: string): Promise<void> {
    return this.storage.deleteObject(bucket, key);
  }

  // ─── Relational Metadata Persistence (Prisma) ───────────────────────────────

  public async save(file: ManuscriptFile): Promise<ManuscriptFile> {
    const data = ManuscriptFileMapper.toPersistence(file);

    const upserted = await this.prisma.manuscriptFile.upsert({
      where: { id: data.id },
      create: {
        id: data.id,
        projectId: data.projectId,
        name: data.name,
        mimeType: data.mimeType,
        sizeBytes: data.sizeBytes,
        hash: data.hash,
        storageKey: data.storageKey,
        bucketName: data.bucketName,
        rev: data.rev,
        deleted: data.deleted,
        deletedAt: data.deletedAt,
      },
      update: {
        name: data.name,
        mimeType: data.mimeType,
        sizeBytes: data.sizeBytes,
        hash: data.hash,
        storageKey: data.storageKey,
        bucketName: data.bucketName,
        rev: data.rev,
        deleted: data.deleted,
        deletedAt: data.deletedAt,
      },
    });

    return ManuscriptFileMapper.toDomain(upserted);
  }

  public async findById(id: string): Promise<ManuscriptFile | null> {
    const record = await this.prisma.manuscriptFile.findUnique({
      where: { id },
    });
    return record ? ManuscriptFileMapper.toDomain(record) : null;
  }

  public async findByProjectAndId(
    projectId: string,
    id: string,
  ): Promise<ManuscriptFile | null> {
    const record = await this.prisma.manuscriptFile.findFirst({
      where: {
        id,
        projectId,
      },
    });
    return record ? ManuscriptFileMapper.toDomain(record) : null;
  }

  public async findByProjectAndName(
    projectId: string,
    name: string,
  ): Promise<ManuscriptFile | null> {
    const record = await this.prisma.manuscriptFile.findFirst({
      where: {
        projectId,
        name,
        deleted: false,
      },
    });
    return record ? ManuscriptFileMapper.toDomain(record) : null;
  }

  public async findByHash(hash: string): Promise<ManuscriptFile[]> {
    const records = await this.prisma.manuscriptFile.findMany({
      where: {
        hash,
        deleted: false,
      },
    });
    return records.map(ManuscriptFileMapper.toDomain);
  }

  public async listByProject(
    projectId: string,
    includeDeleted = false,
  ): Promise<ManuscriptFile[]> {
    const records = await this.prisma.manuscriptFile.findMany({
      where: {
        projectId,
        ...(includeDeleted ? {} : { deleted: false }),
      },
      orderBy: { createdAt: 'desc' },
    });
    return records.map(ManuscriptFileMapper.toDomain);
  }

  public async delete(id: string): Promise<void> {
    await this.prisma.manuscriptFile.update({
      where: { id },
      data: {
        deleted: true,
        deletedAt: new Date(),
      },
    });
  }

  public async countReferencesByHash(hash: string): Promise<number> {
    return await this.prisma.manuscriptFile.count({
      where: {
        hash,
        deleted: false,
      },
    });
  }
}
