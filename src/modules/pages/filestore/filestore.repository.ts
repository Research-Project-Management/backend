/**
 * filestore/filestore.repository.ts
 * Direct @Injectable() Prisma Persistence Repository & Domain Mapper for Manuscripts Filestore.
 */

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Readable } from 'node:stream';
import { PageFile as PrismaPageFile } from '@prisma/client';
import { PrismaService } from '@/core';
import { NodePathVo } from '@/modules/pages/structure/domain';
import { ensurePrismaFolderChain } from '@/modules/pages/structure/structure.repository';
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
  ContentHasherAdapter,
  CryptoGitBlobHasherAdapter,
  PlatformBinaryStorageAdapter,
  LocalDiskBinaryStorageAdapter,
} from './adapters/filestore.adapters';

export {
  ContentHasherAdapter,
  CryptoGitBlobHasherAdapter,
  PlatformBinaryStorageAdapter,
  LocalDiskBinaryStorageAdapter,
};

export class ManuscriptFileMapper {
  public static toDomain(row: PrismaPageFile): ManuscriptFile {
    const projectId =
      row.spaceId ?? (row as { projectId?: string }).projectId ?? '';
    return ManuscriptFile.reconstitute({
      id: row.id,
      projectId,
      pageId: (row as { pageId?: string | null }).pageId ?? null,
      name: row.name,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      hash: ContentHash.create(row.hash),
      storageKey: StorageKey.fromRawKey(row.storageKey),
      bucketName: row.bucketName,
      rev: row.rev,
      deleted: Boolean(
        row.deletedAt ?? (row as { deleted?: boolean }).deleted,
      ),
      deletedAt: row.deletedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }

  public static toPersistence(entity: ManuscriptFile): {
    id: string;
    spaceId: string;
    projectId: string;
    pageId?: string | null;
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
      spaceId: entity.projectId,
      projectId: entity.projectId,
      ...(entity.pageId ? { pageId: entity.pageId } : {}),
      name: entity.name,
      mimeType: entity.mimeType,
      sizeBytes: entity.sizeBytes,
      hash: entity.hash.getValue(),
      storageKey: entity.storageKey.getValue(),
      bucketName: entity.bucketName,
      rev: entity.rev,
      deleted: entity.deleted,
      deletedAt: entity.deleted
        ? (entity.deletedAt ?? new Date())
        : null,
    };
  }
}

@Injectable()
export class FilestoreRepository extends IManuscriptFileRepository {
  private readonly logger = new Logger(FilestoreRepository.name);
  private readonly storage: IBinaryStoragePort;
  private readonly hasher: ContentHasherAdapter;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(IBinaryStoragePort) storage?: IBinaryStoragePort,
    @Optional() hasher?: ContentHasherAdapter,
  ) {
    super();
    this.storage = storage ?? new LocalDiskBinaryStorageAdapter();
    this.hasher = hasher ?? new ContentHasherAdapter();
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

  public async save(
    file: ManuscriptFile,
    options?: { syncStructureNode?: boolean },
  ): Promise<ManuscriptFile> {
    const data = ManuscriptFileMapper.toPersistence(file);

    const upserted = await this.prisma.pageFile.upsert({
      where: { id: data.id },
      create: {
        id: data.id,
        spaceId: data.spaceId,
        ...(data.pageId ? { pageId: data.pageId } : {}),
        name: data.name,
        mimeType: data.mimeType,
        sizeBytes: data.sizeBytes,
        hash: data.hash,
        storageKey: data.storageKey,
        bucketName: data.bucketName,
        rev: data.rev,
        deletedAt: data.deletedAt,
      },
      update: {
        ...(data.pageId ? { pageId: data.pageId } : {}),
        name: data.name,
        mimeType: data.mimeType,
        sizeBytes: data.sizeBytes,
        hash: data.hash,
        storageKey: data.storageKey,
        bucketName: data.bucketName,
        rev: data.rev,
        deletedAt: data.deletedAt,
      },
    });

    if (options?.syncStructureNode !== false) {
      await this.syncFileNode(data);
    }

    return ManuscriptFileMapper.toDomain(upserted);
  }

  private async syncFileNode(data: {
    id: string;
    spaceId: string;
    projectId: string;
    pageId?: string | null;
    name: string;
    sizeBytes: number;
    hash: string;
    deleted: boolean;
  }): Promise<void> {
    if (!this.prisma?.pageNode) {
      return;
    }

    try {
      if (data.deleted) {
        await this.prisma.pageNode.deleteMany?.({
          where: {
            spaceId: data.spaceId,
            fileId: data.id,
          },
        });
        return;
      }

      const parsed = NodePathVo.parse(data.name || 'unnamed.bin', 'unnamed.bin');

      const existingByFileId = await this.prisma.pageNode.findFirst?.({
        where: {
          spaceId: data.spaceId,
          fileId: data.id,
        },
      });

      if (existingByFileId) {
        const pathChanged = existingByFileId.path !== parsed.normalizedPath;
        const nextParentId = pathChanged
          ? await ensurePrismaFolderChain(
              this.prisma,
              data.spaceId,
              parsed.folderChain,
              data.pageId,
            )
          : undefined;
        await this.prisma.pageNode.updateMany?.({
          where: { id: existingByFileId.id, spaceId: data.spaceId },
          data: {
            sizeBytes: data.sizeBytes,
            hash: data.hash,
            ...(pathChanged
              ? {
                  name: parsed.leafName,
                  path: parsed.normalizedPath,
                  depth: parsed.depth,
                  parentId: nextParentId ?? null,
                }
              : {}),
          },
        });
        return;
      }

      const parentId = await ensurePrismaFolderChain(
        this.prisma,
        data.spaceId,
        parsed.folderChain,
        data.pageId,
      );

      const existingByPath =
        (data.pageId
          ? await this.prisma.pageNode.findUnique?.({
              where: {
                pageId_path: {
                  pageId: data.pageId,
                  path: parsed.normalizedPath,
                },
              },
            })
          : null) ??
        (await this.prisma.pageNode.findFirst?.({
          where: {
            spaceId: data.spaceId,
            ...(data.pageId ? { pageId: data.pageId } : {}),
            path: parsed.normalizedPath,
          },
        }));

      if (existingByPath) {
        if (existingByPath.type === 'FILE') {
          await this.prisma.pageNode.updateMany?.({
            where: { id: existingByPath.id, spaceId: data.spaceId },
            data: {
              fileId: data.id,
              sizeBytes: data.sizeBytes,
              hash: data.hash,
            },
          });
        }
        return;
      }

      if (this.prisma.pageNode.create) {
        await this.prisma.pageNode.create({
          data: {
            spaceId: data.spaceId,
            ...(data.pageId ? { pageId: data.pageId } : {}),
            parentId,
            type: 'FILE',
            name: parsed.leafName,
            path: parsed.normalizedPath,
            depth: parsed.depth,
            fileId: data.id,
            isRootDoc: false,
            sizeBytes: data.sizeBytes,
            hash: data.hash,
            sortOrder: 0,
          },
        });
      }
    } catch (err) {
      this.logger.warn(
        `Failed to sync PageNode for file '${data.id}' in space '${data.spaceId}': ${(err as Error).message}`,
      );
    }
  }

  public async findById(id: string): Promise<ManuscriptFile | null> {
    const record = await this.prisma.pageFile.findUnique({
      where: { id },
    });
    return record ? ManuscriptFileMapper.toDomain(record) : null;
  }

  public async findByProjectAndId(
    projectId: string,
    id: string,
  ): Promise<ManuscriptFile | null> {
    const record = await this.prisma.pageFile.findFirst({
      where: {
        id,
        spaceId: projectId,
      },
    });
    return record ? ManuscriptFileMapper.toDomain(record) : null;
  }

  public async findByProjectAndName(
    projectId: string,
    name: string,
  ): Promise<ManuscriptFile | null> {
    const record = await this.prisma.pageFile.findFirst({
      where: {
        spaceId: projectId,
        name,
        deletedAt: null,
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

    const records = await this.prisma.pageFile.findMany({
      where: {
        spaceId: projectId,
        deletedAt: null,
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
    const records = await this.prisma.pageFile.findMany({
      where: {
        hash,
        deletedAt: null,
      },
    });
    return records.map(ManuscriptFileMapper.toDomain);
  }

  public async listByProject(
    projectId: string,
    includeDeleted = false,
  ): Promise<ManuscriptFile[]> {
    const records = await this.prisma.pageFile.findMany({
      where: {
        spaceId: projectId,
        ...(includeDeleted ? {} : { deletedAt: null }),
      },
      orderBy: { createdAt: 'desc' },
    });
    return records.map(ManuscriptFileMapper.toDomain);
  }

  public async delete(id: string): Promise<void> {
    await this.prisma.pageFile.update({
      where: { id },
      data: {
        deletedAt: new Date(),
      },
    });
    await this.prisma.pageNode?.deleteMany?.({
      where: { fileId: id },
    });
  }

  public async countReferencesByHash(hash: string): Promise<number> {
    return await this.prisma.pageFile.count({
      where: {
        hash,
        deletedAt: null,
      },
    });
  }
}
