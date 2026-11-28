/**
 * modules/pages/filestore/filestore.repository.ts
 * Direct @Injectable() Prisma Persistence Repository & Domain Mapper for Pages Binary Filestore.
 */

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Readable } from 'node:stream';
import { PageFile as PrismaPageFile } from '@prisma/client';
import { PrismaService, isUuid } from '@/core';
import {
  ensureCanonicalPageId,
  filterRecordsByPageScope,
  resolveCanonicalPageId,
} from '@/modules/pages/core/utils/page-scope';
import { NodePathVo } from '@/modules/pages/core/utils/node-path';
import { ensurePrismaFolderChain } from '@/modules/pages/core/utils/folder-chain';
import { IBinaryStoragePort } from './domain/filestore.ports';
import {
  StorageObjectMetadata,
  StorageRangeOptions,
  StorageUploadOptions,
  StreamHashResult,
} from './types/filestore.types';
import {
  PageBinaryAsset,
  ContentHash,
  StorageKey,
} from './domain/file.entity';
import { DuplicateFileException } from './domain/filestore.errors';
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

export class PageBinaryAssetMapper {
  public static toDomain(
    row: PrismaPageFile & { name?: string },
  ): PageBinaryAsset {
    const projectId =
      row.spaceId ?? (row as { projectId?: string }).projectId ?? '';
    return PageBinaryAsset.reconstitute({
      id: row.id,
      projectId,
      pageId: row.pageId ?? null,
      blobId: row.blobId ?? null,
      name: row.lastKnownPath ?? row.name ?? 'unnamed.bin',
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      hash: ContentHash.create(row.hash),
      storageKey: StorageKey.fromRawKey(row.storageKey),
      bucketName: row.bucketName,
      rev: row.rev,
      deleted: Boolean(row.deletedAt ?? (row as { deleted?: boolean }).deleted),
      deletedAt: row.deletedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }

  public static toPersistence(entity: PageBinaryAsset): {
    id: string;
    spaceId: string;
    projectId: string;
    pageId?: string | null;
    blobId?: string | null;
    lastKnownPath: string;
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
      blobId: entity.blobId,
      lastKnownPath: entity.name,
      mimeType: entity.mimeType,
      sizeBytes: entity.sizeBytes,
      hash: entity.hash.getValue(),
      storageKey: entity.storageKey.getValue(),
      bucketName: entity.bucketName,
      rev: entity.rev,
      deleted: entity.deleted,
      deletedAt: entity.deleted ? (entity.deletedAt ?? new Date()) : null,
    };
  }
}

@Injectable()
export class FilestoreRepository {
  private readonly logger = new Logger(FilestoreRepository.name);
  private readonly storage: IBinaryStoragePort;
  private readonly hasher: ContentHasherAdapter;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(IBinaryStoragePort) storage?: IBinaryStoragePort,
    @Optional() hasher?: ContentHasherAdapter,
  ) {
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
    file: PageBinaryAsset,
    options?: { syncStructureNode?: boolean },
  ): Promise<PageBinaryAsset> {
    const data = PageBinaryAssetMapper.toPersistence(file);
    const effectivePageId = await ensureCanonicalPageId(
      this.prisma,
      data.spaceId,
      data.pageId,
    );

    const upserted = await this.prisma.pageFile.upsert({
      where: { id: data.id },
      create: {
        id: data.id,
        spaceId: data.spaceId,
        pageId: effectivePageId,
        blobId: data.blobId ?? null,
        lastKnownPath: data.lastKnownPath,
        mimeType: data.mimeType,
        sizeBytes: data.sizeBytes,
        hash: data.hash,
        storageKey: data.storageKey,
        bucketName: data.bucketName,
        rev: data.rev,
        deletedAt: data.deletedAt,
      },
      update: {
        pageId: effectivePageId,
        ...(data.blobId !== undefined ? { blobId: data.blobId } : {}),
        lastKnownPath: data.lastKnownPath,
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
      await this.syncFileNode({
        ...data,
        pageId: effectivePageId,
      });
    }

    return PageBinaryAssetMapper.toDomain(upserted);
  }

  private async syncFileNode(data: {
    id: string;
    spaceId: string;
    projectId: string;
    pageId: string;
    lastKnownPath: string;
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

      const parsed = NodePathVo.parse(
        data.lastKnownPath || 'unnamed.bin',
        'unnamed.bin',
      );

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
            ...(data.pageId && existingByFileId.pageId !== data.pageId
              ? { pageId: data.pageId }
              : {}),
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
        (await this.prisma.pageNode.findUnique?.({
          where: {
            pageId_path: {
              pageId: data.pageId,
              path: parsed.normalizedPath,
            },
          },
        })) ??
        (await this.prisma.pageNode.findFirst?.({
          where: {
            spaceId: data.spaceId,
            pageId: data.pageId,
            path: parsed.normalizedPath,
          },
        }));

      if (existingByPath) {
        if (existingByPath.type === 'FILE') {
          if (existingByPath.fileId && existingByPath.fileId !== data.id) {
            await this.prisma.pageFile?.updateMany?.({
              where: {
                id: existingByPath.fileId,
                spaceId: data.spaceId,
                deletedAt: null,
              },
              data: { deletedAt: new Date() },
            });
          }
          await this.prisma.pageNode.updateMany?.({
            where: { id: existingByPath.id, spaceId: data.spaceId },
            data: {
              fileId: data.id,
            },
          });
        }
        return;
      }

      if (this.prisma.pageNode.create) {
        await this.prisma.pageNode.create({
          data: {
            spaceId: data.spaceId,
            pageId: data.pageId,
            parentId,
            type: 'FILE',
            name: parsed.leafName,
            path: parsed.normalizedPath,
            depth: parsed.depth,
            fileId: data.id,
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

  public async assertUploadPathAvailable(
    projectId: string,
    relativePath: string,
    pageId?: string | null,
  ): Promise<void> {
    if (!this.prisma.pageNode?.findFirst) return;
    const parsed = NodePathVo.parse(relativePath);
    const effectivePageId = await ensureCanonicalPageId(
      this.prisma,
      projectId,
      pageId,
      { autoCreate: false },
    );
    const pageFilter = effectivePageId ? { pageId: effectivePageId } : {};

    const existingAtTarget = await Promise.resolve(
      this.prisma.pageNode.findFirst({
        where: {
          spaceId: projectId,
          ...pageFilter,
          path: parsed.normalizedPath,
        },
        select: { id: true, type: true },
      }),
    ).catch(() => null);
    if (existingAtTarget && existingAtTarget.type !== 'FILE') {
      throw new DuplicateFileException(relativePath, projectId);
    }

    if (parsed.folderChain.length > 0) {
      const blockingAncestor = await Promise.resolve(
        this.prisma.pageNode.findFirst({
          where: {
            spaceId: projectId,
            ...pageFilter,
            path: { in: parsed.folderChain.map((seg) => seg.path) },
            type: { not: 'FOLDER' },
          },
          select: { id: true, type: true },
        }),
      ).catch(() => null);
      if (blockingAncestor) {
        throw new DuplicateFileException(relativePath, projectId);
      }
    }
  }

  public async resolvePageId(
    projectId: string,
    candidatePageId?: string | null,
  ): Promise<string | undefined> {
    const trimmedCandidate = candidatePageId?.trim() || undefined;
    if (!trimmedCandidate || !isUuid(trimmedCandidate)) {
      return await ensureCanonicalPageId(this.prisma, projectId, undefined, {
        autoCreate: false,
      });
    }

    if (this.prisma.page?.findUnique) {
      const page = await Promise.resolve(
        this.prisma.page.findUnique({
          where: { id: trimmedCandidate },
          select: { id: true, spaceId: true, deletedAt: true },
        }),
      ).catch(() => null);
      if (page?.id && !page.deletedAt) {
        if (!page.spaceId || page.spaceId === projectId) {
          return page.id;
        }
        return undefined;
      }
    }

    if (this.prisma.pageDoc?.findFirst) {
      const doc = await Promise.resolve(
        this.prisma.pageDoc.findFirst({
          where: { id: trimmedCandidate, spaceId: projectId },
          select: { id: true, pageId: true },
        }),
      ).catch(() => null);
      if (doc) {
        return (doc as { pageId?: string | null }).pageId ?? undefined;
      }
    }

    const canonical = await resolveCanonicalPageId(
      this.prisma,
      projectId,
      trimmedCandidate,
    ).catch(() => undefined);
    if (canonical) return canonical;

    return await ensureCanonicalPageId(
      this.prisma,
      projectId,
      trimmedCandidate,
      { autoCreate: false },
    );
  }

  public async findById(id: string): Promise<PageBinaryAsset | null> {
    const record = await this.prisma.pageFile.findUnique({
      where: { id },
    });
    return record ? PageBinaryAssetMapper.toDomain(record) : null;
  }

  public async findByProjectAndId(
    projectId: string,
    id: string,
    pageId?: string | null,
  ): Promise<PageBinaryAsset | null> {
    const trimmedPageId = pageId?.trim() || undefined;
    const record = await this.prisma.pageFile.findFirst({
      where: {
        id,
        spaceId: projectId,
        ...(trimmedPageId ? { pageId: trimmedPageId } : {}),
      },
    });
    return record ? PageBinaryAssetMapper.toDomain(record) : null;
  }

  public async findManyByProjectAndIds(
    projectId: string,
    ids: string[],
  ): Promise<PageBinaryAsset[]> {
    if (!ids.length || !this.prisma?.pageFile?.findMany) {
      return [];
    }
    const records = await this.prisma.pageFile.findMany({
      where: {
        spaceId: projectId,
        id: { in: ids },
      },
    });
    return records.map(PageBinaryAssetMapper.toDomain);
  }

  public async markDeletedIfActive(
    projectId: string,
    fileId: string,
    pageId?: string | null,
  ): Promise<boolean | null> {
    if (!this.prisma?.pageFile?.updateMany) return null;
    const trimmedPageId = pageId?.trim() || undefined;
    const now = new Date();
    const result = await this.prisma.pageFile.updateMany({
      where: {
        id: fileId,
        spaceId: projectId,
        ...(trimmedPageId ? { pageId: trimmedPageId } : {}),
        deletedAt: null,
      },
      data: { deletedAt: now },
    });
    if (result.count > 0 && this.prisma.pageNode?.deleteMany) {
      await this.prisma.pageNode.deleteMany({
        where: {
          spaceId: projectId,
          fileId,
        },
      });
    }
    return result.count > 0;
  }

  public async purge(
    projectId: string,
    fileId: string,
    pageId?: string | null,
  ): Promise<boolean> {
    const trimmedPageId = pageId?.trim() || undefined;
    if (this.prisma?.pageNode?.deleteMany) {
      await this.prisma.pageNode.deleteMany({
        where: {
          spaceId: projectId,
          fileId,
        },
      });
    }
    if (this.prisma?.pageFile?.deleteMany) {
      const res = await this.prisma.pageFile.deleteMany({
        where: {
          id: fileId,
          spaceId: projectId,
          ...(trimmedPageId ? { pageId: trimmedPageId } : {}),
        },
      });
      return res.count > 0;
    }
    if (this.prisma?.pageFile?.delete) {
      await this.prisma.pageFile.delete({ where: { id: fileId } });
      return true;
    }
    return false;
  }

  public async findByProjectAndName(
    projectId: string,
    name: string,
    pageId?: string | null,
  ): Promise<PageBinaryAsset | null> {
    const effectivePageId = await ensureCanonicalPageId(
      this.prisma,
      projectId,
      pageId,
      { autoCreate: false },
    );
    const record = await this.prisma.pageFile.findFirst({
      where: {
        spaceId: projectId,
        pageId: effectivePageId,
        lastKnownPath: name,
        deletedAt: null,
      },
    });
    return record ? PageBinaryAssetMapper.toDomain(record) : null;
  }

  public async findFileByPathFlexible(
    projectId: string,
    rawPath: string,
    pageId?: string | null,
  ): Promise<PageBinaryAsset | null> {
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
        lastKnownPath: { in: candidates },
      },
    });

    const scopedRecords = pageId
      ? filterRecordsByPageScope(records, pageId, projectId)
      : records;

    if (scopedRecords.length === 0) {
      return null;
    }

    for (const candidate of candidates) {
      const match = scopedRecords.find(
        (r) => (r.lastKnownPath ?? (r as { name?: string }).name) === candidate,
      );
      if (match) {
        return PageBinaryAssetMapper.toDomain(match);
      }
    }

    return PageBinaryAssetMapper.toDomain(scopedRecords[0]);
  }

  public async markRestoredIfDeleted(
    projectId: string,
    fileId: string,
  ): Promise<boolean> {
    if (!this.prisma?.pageFile?.updateMany) return false;
    const result = await this.prisma.pageFile.updateMany({
      where: {
        id: fileId,
        spaceId: projectId,
        deletedAt: { not: null },
      },
      data: { deletedAt: null },
    });
    return result.count > 0;
  }

  public async findByHash(hash: string): Promise<PageBinaryAsset[]> {
    const records = await this.prisma.pageFile.findMany({
      where: {
        hash,
        deletedAt: null,
      },
    });
    return records.map(PageBinaryAssetMapper.toDomain);
  }

  public async listByProject(
    projectId: string,
    includeDeleted = false,
    pageId?: string | null,
  ): Promise<PageBinaryAsset[]> {
    const records = await this.prisma.pageFile.findMany({
      where: {
        spaceId: projectId,
        ...(includeDeleted ? {} : { deletedAt: null }),
      },
      orderBy: { createdAt: 'desc' },
    });
    const scopedRecords = pageId
      ? filterRecordsByPageScope(records, pageId, projectId)
      : records;
    return scopedRecords.map(PageBinaryAssetMapper.toDomain);
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
      },
    });
  }
}
