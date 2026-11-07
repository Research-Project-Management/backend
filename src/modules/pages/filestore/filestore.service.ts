/**
 * filestore/filestore.service.ts
 * Deep Module Service for Manuscripts Filestore.
 * Consolidates Content-Addressable Storage (CAS) upload, byte-range streaming,
 * metadata queries, signed URLs, and reference-counted deletion.
 */

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Readable } from 'node:stream';
import { STORAGE_QUOTA_REPOSITORY } from '@/modules/storage/storage.tokens';
import {
  BlobService,
  ContentHash as PlatformContentHash,
} from '@/modules/storage/core';
import { IStorageQuotaRepository } from '@/modules/storage/drive';
import { NodePathVo } from '@/modules/pages/structure/domain';
import { FilestoreRepository } from './filestore.repository';
import {
  ManuscriptFile,
  StorageKey,
  ByteRange,
  FileNotFoundException,
  StorageObjectMetadata,
  StreamManuscriptFileOutput,
  GetFileHeadOutput,
  MAX_FILE_SIZE_BYTES,
  StorageQuotaExceededException,
} from './filestore.types';

@Injectable()
export class FilestoreService {
  private readonly logger = new Logger(FilestoreService.name);

  constructor(
    private readonly repository: FilestoreRepository,
    @Optional() private readonly eventEmitter?: EventEmitter2,
    @Optional() private readonly blobService?: BlobService,
    @Optional()
    @Inject(STORAGE_QUOTA_REPOSITORY)
    private readonly quotaRepo?: IStorageQuotaRepository,
  ) {}

  /**
   * Directly opens a readable stream for a file without passing through HTTP.
   * Used by ClsiService and GitBridgeService to hydrate workspaces with figures, fonts, and packages.
   */
  public async openReadStream(
    projectId: string,
    fileId: string,
  ): Promise<{ file: ManuscriptFile; stream: Readable }> {
    const result = await this.streamFile(projectId, fileId);
    return {
      file: result.file,
      stream: result.stream,
    };
  }

  /**
   * Streams binary content with optional RFC 7233 byte-range slicing.
   */
  public async streamFile(
    projectId: string,
    fileId: string,
    rangeHeader?: string,
  ): Promise<StreamManuscriptFileOutput> {
    const file = await this.repository.findByProjectAndId(projectId, fileId);
    if (!file || file.deleted) {
      throw new FileNotFoundException(fileId, projectId);
    }

    const byteRange = ByteRange.parse(rangeHeader, file.sizeBytes);
    const rangeOpts = byteRange
      ? { start: byteRange.start, end: byteRange.end }
      : undefined;

    const stream = await this.repository.getObjectStream(
      file.bucketName,
      file.storageKey.getValue(),
      rangeOpts,
    );

    const isPartialContent = byteRange !== null;
    const contentLength = byteRange ? byteRange.contentLength : file.sizeBytes;

    return {
      file,
      stream,
      byteRange,
      isPartialContent,
      contentLength,
    };
  }

  /**
   * Programmatic upload of binary asset from an in-memory buffer.
   */
  public async uploadFileFromBuffer(
    projectId: string,
    name: string,
    buffer: Buffer,
    mimeType?: string,
    options?: { syncStructureNode?: boolean },
  ): Promise<ManuscriptFile> {
    const stream = Readable.from(buffer);
    return await this.uploadFileFromStream(
      projectId,
      name,
      stream,
      mimeType,
      'manuscript-files',
      { syncStructureNode: options?.syncStructureNode ?? true },
    );
  }

  /**
   * Programmatic upload of binary asset from a readable stream with Git-blob CAS deduplication.
   */
  public async uploadFileFromStream(
    projectId: string,
    name: string,
    stream: Readable,
    mimeType?: string,
    bucketName = 'manuscript-files',
    options?: { syncStructureNode?: boolean },
  ): Promise<ManuscriptFile> {
    // Validate filename BEFORE spooling stream or writing to S3/disk storage
    const sanitizedName = ManuscriptFile.sanitizeFilename(name);

    const { contentHash, sha256Hex, sizeBytes, dataStream } =
      await this.repository.hashStream(stream);

    if (sizeBytes > MAX_FILE_SIZE_BYTES) {
      dataStream.destroy();
      throw new StorageQuotaExceededException(sizeBytes, MAX_FILE_SIZE_BYTES);
    }

    const existing = await this.repository.findByProjectAndName(
      projectId,
      sanitizedName,
    );

    // Enforce unified platform Space StorageQuota before writing physical object
    const netBytesDelta = BigInt(sizeBytes) - BigInt(existing?.sizeBytes ?? 0);
    if (this.quotaRepo && netBytesDelta > 0n) {
      await this.quotaRepo.incrementUsage(null, projectId, netBytesDelta);
    } else if (this.quotaRepo && netBytesDelta < 0n) {
      await this.quotaRepo.decrementUsage(null, projectId, -netBytesDelta);
    }

    let storageKey = this.repository.buildStorageKey(contentHash);

    const blobExists = await this.repository.checkObjectExists(
      bucketName,
      storageKey.getValue(),
    );

    if (blobExists) {
      dataStream.destroy();
      this.logger.log(
        `[CAS Deduplication] Reusing existing blob '${storageKey.getValue()}' for file '${sanitizedName}' in project '${projectId}'. (0 bytes written to storage)`,
      );
    } else {
      await this.repository.sendStream(
        bucketName,
        storageKey.getValue(),
        dataStream,
        {
          contentType: mimeType || 'application/octet-stream',
        },
      );
      this.logger.log(
        `[CAS Write] Stored new blob '${storageKey.getValue()}' (${sizeBytes} bytes) for project '${projectId}'.`,
      );
    }

    // Register or increment reference count in platform StorageBlob CAS ledger
    if (this.blobService && sha256Hex && /^[a-f0-9]{64}$/i.test(sha256Hex)) {
      try {
        const casResult = await this.blobService.registerUploadedObject({
          storageKey: storageKey.getValue(),
          sizeBytes: BigInt(sizeBytes),
          contentHashHex: sha256Hex,
        });
        if (casResult?.blob?.s3Key) {
          storageKey = StorageKey.fromRawKey(casResult.blob.s3Key.value());
        }
      } catch (err) {
        this.logger.warn(
          `[CAS Ledger] Failed to register StorageBlob for '${sanitizedName}': ${(err as Error).message}`,
        );
      }
    }

    const fileEntity = ManuscriptFile.reconstitute({
      id: existing?.id ?? ManuscriptFile.create({
        projectId,
        name: sanitizedName,
        mimeType: mimeType || 'application/octet-stream',
        sizeBytes,
        hash: contentHash,
        storageKey,
        bucketName,
      }).id,
      projectId,
      name: sanitizedName,
      mimeType: mimeType || 'application/octet-stream',
      sizeBytes,
      hash: contentHash,
      storageKey,
      bucketName,
      rev: existing ? existing.rev + 1 : 0,
      deleted: false,
      deletedAt: null,
      createdAt: existing?.createdAt ?? new Date(),
      updatedAt: new Date(),
    });

    const saved = await (
      this.repository.save as (
        f: ManuscriptFile,
        opts?: { syncStructureNode?: boolean },
      ) => Promise<ManuscriptFile>
    )(fileEntity, options);

    if (options?.syncStructureNode !== false) {
      const parsedPath = NodePathVo.parse(
        saved.name || 'unnamed.bin',
        'unnamed.bin',
      );
      this.eventEmitter?.emit('manuscripts.file-tree.change', {
        projectId,
        change: {
          action: 'create',
          node: {
            id: saved.id,
            fileId: saved.id,
            name: parsedPath.leafName,
            path: parsedPath.normalizedPath,
          },
        },
      });
    }

    return saved;
  }

  /**
   * Fast metadata and storage header retrieval without payload download.
   */
  public async getFileHead(
    projectId: string,
    fileId: string,
  ): Promise<GetFileHeadOutput> {
    const file = await this.repository.findByProjectAndId(projectId, fileId);
    if (!file || file.deleted) {
      throw new FileNotFoundException(fileId, projectId);
    }

    let storageMetadata: StorageObjectMetadata | undefined;
    try {
      storageMetadata = await this.repository.getObjectMetadata?.(
        file.bucketName,
        file.storageKey.getValue(),
      );
    } catch {
      // Storage metadata optional; file entity sizeBytes is authoritative
    }

    return { file, storageMetadata };
  }

  /**
   * Fast metadata query.
   */
  public async getFileMetadata(
    projectId: string,
    fileId: string,
  ): Promise<ManuscriptFile> {
    const result = await this.getFileHead(projectId, fileId);
    return result.file;
  }

  /**
   * List all files in a manuscript project.
   */
  public async listFiles(
    projectId: string,
    includeDeleted = false,
  ): Promise<ManuscriptFile[]> {
    return await this.repository.listByProject(projectId, includeDeleted);
  }

  /**
   * Find file by project ID and relative path / leaf name.
   */
  public async findByProjectAndName(
    projectId: string,
    name: string,
  ): Promise<ManuscriptFile | null> {
    return await this.repository.findByProjectAndName(projectId, name);
  }

  /**
   * Resolve file by exact path, leaf basename, or implicit LaTeX graphics extension in a single query.
   */
  public async findFileByPathFlexible(
    projectId: string,
    rawPath: string,
  ): Promise<ManuscriptFile | null> {
    return await this.repository.findFileByPathFlexible(projectId, rawPath);
  }

  /**
   * Delete file record and optionally garbage-collect unreferenced physical CAS blob.
   */
  public async deleteFile(
    projectId: string,
    fileId: string,
    purgeBlob = false,
  ): Promise<void> {
    const file = await this.repository.findByProjectAndId(projectId, fileId);
    if (!file || file.deleted) {
      throw new FileNotFoundException(fileId, projectId);
    }

    file.markDeleted();
    await this.repository.save(file);

    // Reclaim unified platform Space StorageQuota upon deletion
    if (this.quotaRepo && file.sizeBytes > 0) {
      await this.quotaRepo
        .decrementUsage(null, projectId, BigInt(file.sizeBytes))
        .catch((err: unknown) => {
          this.logger.warn(
            `[Quota] Failed to decrement Space quota for project '${projectId}': ${(err as Error).message}`,
          );
        });
    }

    // Release reference in unified platform StorageBlob CAS ledger
    if (this.blobService) {
      const rawHash = file.hash.getValue();
      if (/^[a-f0-9]{64}$/i.test(rawHash)) {
        try {
          const blob = await this.blobService.findBlobByHash(
            PlatformContentHash.fromHex(rawHash),
          );
          if (blob) {
            await this.blobService.releaseBlob(blob.id);
          }
        } catch (err) {
          this.logger.warn(
            `[CAS Ledger] Failed to release StorageBlob for '${file.id}': ${(err as Error).message}`,
          );
        }
      }
    }

    this.eventEmitter?.emit('manuscripts.file-tree.change', {
      projectId,
      change: {
        action: 'delete',
        node: {
          id: fileId,
          fileId,
        },
      },
    });

    if (purgeBlob) {
      const remainingRefs = await this.repository.countReferencesByHash(
        file.hash.getValue(),
      );
      if (remainingRefs === 0) {
        try {
          await this.repository.deleteObject(
            file.bucketName,
            file.storageKey.getValue(),
          );
          this.logger.log(
            `[CAS GC] Purged unreferenced physical blob '${file.storageKey.getValue()}'.`,
          );
        } catch (err) {
          this.logger.warn(
            `[CAS GC] Failed to purge blob '${file.storageKey.getValue()}': ${(err as Error).message}`,
          );
        }
      }
    }
  }

  /**
   * Reclaims unified platform Space StorageQuota and decrements StorageBlob CAS refCounts
   * when binary files are soft-deleted in bulk via StructureService.deleteNode / deleteSubtree.
   */
  public async reclaimDeletedFilesQuotaAndBlobs(
    projectId: string,
    fileIds: string[],
    deletedNodes?: Array<{ fileId?: string | null; sizeBytes?: number; hash?: string | null }>,
  ): Promise<void> {
    if (!fileIds || fileIds.length === 0) return;

    let totalReclaimedBytes = 0n;
    const hashesToRelease: string[] = [];

    if (deletedNodes && deletedNodes.length > 0) {
      const seenFileIds = new Set<string>();
      for (const n of deletedNodes) {
        if (!n.fileId || seenFileIds.has(n.fileId)) continue;
        seenFileIds.add(n.fileId);
        if (typeof n.sizeBytes === 'number' && n.sizeBytes > 0) {
          totalReclaimedBytes += BigInt(n.sizeBytes);
        }
        if (typeof n.hash === 'string' && /^[a-f0-9]{64}$/i.test(n.hash)) {
          hashesToRelease.push(n.hash);
        }
      }
    } else {
      for (const fileId of fileIds) {
        const f = await this.repository
          .findByProjectAndId(projectId, fileId)
          .catch(() => null);
        if (f && f.sizeBytes > 0) {
          totalReclaimedBytes += BigInt(f.sizeBytes);
        }
        const rawHash = f?.hash?.getValue?.();
        if (rawHash && /^[a-f0-9]{64}$/i.test(rawHash)) {
          hashesToRelease.push(rawHash);
        }
      }
    }

    if (this.quotaRepo && totalReclaimedBytes > 0n) {
      await this.quotaRepo
        .decrementUsage(null, projectId, totalReclaimedBytes)
        .catch((err: unknown) => {
          this.logger.warn(
            `[Quota] Failed to decrement bulk Space quota for project '${projectId}': ${(err as Error).message}`,
          );
        });
    }

    if (this.blobService && hashesToRelease.length > 0) {
      for (const hex of hashesToRelease) {
        try {
          const blob = await this.blobService.findBlobByHash(
            PlatformContentHash.fromHex(hex),
          );
          if (blob) {
            await this.blobService.releaseBlob(blob.id);
          }
        } catch {
          // Non-blocking CAS release
        }
      }
    }
  }

  /**
   * Restores a soft-deleted file record in the project (used for Memento/Saga rollback).
   */
  public async restoreFile(projectId: string, fileId: string): Promise<boolean> {
    const file = await this.repository.findByProjectAndId(projectId, fileId);
    if (!file) return false;
    if (file.deleted) {
      file.restore();
      await this.repository.save(file);
      if (this.quotaRepo && file.sizeBytes > 0) {
        await this.quotaRepo
          .incrementUsage(null, projectId, BigInt(file.sizeBytes))
          .catch(() => {});
      }
    }
    return true;
  }

  /**
   * Generate pre-signed URL.
   */
  public async getSignedUrl(
    projectId: string,
    fileId: string,
    expiresIn = 3600,
  ): Promise<string | null> {
    const file = await this.repository.findByProjectAndId(projectId, fileId);
    if (!file || file.deleted) {
      throw new FileNotFoundException(fileId, projectId);
    }

    const signedUrl = await this.repository.getSignedDownloadUrl(
      file.bucketName,
      file.storageKey.getValue(),
      expiresIn,
    );

    if (
      !signedUrl ||
      signedUrl.startsWith('/api/manuscripts/filestore/download/')
    ) {
      return `/api/v1/manuscripts/projects/${projectId}/files/${file.id}`;
    }

    return signedUrl;
  }
}
