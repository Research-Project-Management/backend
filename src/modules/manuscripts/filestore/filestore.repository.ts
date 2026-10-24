/**
 * filestore/filestore.repository.ts
 * Direct @Injectable() Prisma Persistence Repository & Domain Mapper for Manuscripts Filestore.
 */

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Readable } from 'node:stream';
import { ManuscriptFile as PrismaManuscriptFile } from '@prisma/client';
import { PrismaService } from '@/core';
import {
  IManuscriptFileRepository,
  IBinaryStoragePort,
  IContentHasherPort,
  StorageObjectMetadata,
  StorageRangeOptions,
  StorageUploadOptions,
  StreamHashResult,
  ManuscriptFile,
  ContentHash,
  StorageKey,
} from './filestore.types';
import {
  CryptoGitBlobHasherAdapter,
  LocalDiskBinaryStorageAdapter,
  S3BinaryStorageAdapter,
} from './adapters/filestore.adapters';

export {
  CryptoGitBlobHasherAdapter,
  LocalDiskBinaryStorageAdapter,
  S3BinaryStorageAdapter,
};

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

@Injectable()
export class FilestoreRepository extends IManuscriptFileRepository {
  private readonly logger = new Logger(FilestoreRepository.name);
  private readonly storage: IBinaryStoragePort;
  private readonly hasher: CryptoGitBlobHasherAdapter;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(IBinaryStoragePort) storage?: IBinaryStoragePort,
    @Optional() @Inject(IContentHasherPort) hasher?: CryptoGitBlobHasherAdapter,
  ) {
    super();
    this.storage = storage ?? new LocalDiskBinaryStorageAdapter();
    this.hasher = hasher ?? new CryptoGitBlobHasherAdapter();
  }

  public async hashStream(stream: Readable): Promise<StreamHashResult> {
    return this.hasher.hashStream(stream);
  }

  public hashBuffer(buffer: Buffer): StreamHashResult {
    return this.hasher.hashBuffer(buffer);
  }

  public buildStorageKey(hash: ContentHash, prefix = 'blobs'): StorageKey {
    return this.hasher.buildStorageKey(hash, prefix);
  }

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

    await this.syncFileNode(data);

    return ManuscriptFileMapper.toDomain(upserted);
  }

  private async syncFileNode(data: {
    id: string;
    projectId: string;
    name: string;
    sizeBytes: number;
    hash: string;
    deleted: boolean;
  }): Promise<void> {
    if (!this.prisma?.manuscriptNode) {
      return;
    }

    try {
      if (data.deleted) {
        await this.prisma.manuscriptNode.deleteMany?.({
          where: {
            projectId: data.projectId,
            fileId: data.id,
          },
        });
        return;
      }

      const rawPath = (data.name || 'unnamed.bin')
        .replace(/\\/g, '/')
        .replace(/^\/+/, '');
      const segments = rawPath.split('/').filter(Boolean);
      const normalizedPath = '/' + segments.join('/');

      const existingByFileId = await this.prisma.manuscriptNode.findFirst?.({
        where: {
          projectId: data.projectId,
          fileId: data.id,
        },
      });

      if (existingByFileId) {
        await this.prisma.manuscriptNode.updateMany?.({
          where: { id: existingByFileId.id, projectId: data.projectId },
          data: {
            sizeBytes: data.sizeBytes,
            hash: data.hash,
          },
        });
        return;
      }

      let parentId: string | null = null;
      if (segments.length > 1) {
        let currentFolderPath = '';
        for (let i = 0; i < segments.length - 1; i++) {
          const folderSegment = segments[i];
          currentFolderPath = `${currentFolderPath}/${folderSegment}`;
          let folderNode = await this.prisma.manuscriptNode.findUnique?.({
            where: {
              projectId_path: {
                projectId: data.projectId,
                path: currentFolderPath,
              },
            },
          });
          if (!folderNode && this.prisma.manuscriptNode.create) {
            folderNode = await this.prisma.manuscriptNode.create({
              data: {
                projectId: data.projectId,
                parentId,
                type: 'FOLDER',
                name: folderSegment,
                path: currentFolderPath,
                depth: i,
                isRootDoc: false,
                sizeBytes: 0,
                sortOrder: 0,
              },
            });
          }
          parentId = folderNode?.id ?? parentId;
        }
      }

      const existingByPath = await this.prisma.manuscriptNode.findUnique?.({
        where: {
          projectId_path: {
            projectId: data.projectId,
            path: normalizedPath,
          },
        },
      });

      if (existingByPath) {
        if (existingByPath.type === 'FILE') {
          await this.prisma.manuscriptNode.updateMany?.({
            where: { id: existingByPath.id, projectId: data.projectId },
            data: {
              fileId: data.id,
              sizeBytes: data.sizeBytes,
              hash: data.hash,
            },
          });
        }
        return;
      }
    } catch (err) {
      this.logger.warn(
        `Failed to sync ManuscriptNode for file '${data.id}' in project '${data.projectId}': ${(err as Error).message}`,
      );
    }
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

  public async findFileByPathFlexible(
    projectId: string,
    rawPath: string,
  ): Promise<ManuscriptFile | null> {
    const cleanPath = rawPath.replace(/^\//, '').trim();
    const leafName = cleanPath.split('/').pop() || cleanPath;
    const extensions = ['.png', '.jpg', '.jpeg', '.pdf', '.svg', '.eps'];

    const candidates: string[] = [cleanPath];
    if (leafName !== cleanPath) {
      candidates.push(leafName);
    }
    for (const ext of extensions) {
      candidates.push(`${cleanPath}${ext}`);
      if (leafName !== cleanPath) {
        candidates.push(`${leafName}${ext}`);
      }
    }

    const records = await this.prisma.manuscriptFile.findMany({
      where: {
        projectId,
        deleted: false,
        name: { in: candidates },
      },
    });

    if (records.length === 0) {
      return null;
    }

    for (const candidate of candidates) {
      const match = records.find((r) => r.name === candidate);
      if (match) {
        return ManuscriptFileMapper.toDomain(match);
      }
    }

    return ManuscriptFileMapper.toDomain(records[0]);
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
    await this.prisma.manuscriptNode?.deleteMany?.({
      where: { fileId: id },
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
