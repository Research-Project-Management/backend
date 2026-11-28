/**
 * modules/pages/filestore/filestore.service.ts
 * Deep Module Service for Pages Binary Filestore.
 * Consolidates Content-Addressable Storage (CAS) upload, byte-range streaming,
 * metadata queries, signed URLs, and reference-counted deletion.
 */

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Readable } from 'node:stream';
import { isUuid } from '@/core';
import { BlobStatus, type IFilesPort } from '@/modules/files/types/files.type';
import { FILES_PORT } from '@/modules/files/files.constant';
import { NodePathVo } from '@/modules/pages/core/utils/node-path';
import { FilestoreRepository } from './filestore.repository';
import {
  PageBinaryAsset,
  StorageKey,
  ByteRange,
} from './domain/file.entity';
import {
  FileNotFoundException,
  MAX_FILE_SIZE_BYTES,
  StorageQuotaExceededException,
} from './domain/filestore.errors';
import {
  StorageObjectMetadata,
  StreamPageBinaryAssetOutput,
  GetFileHeadOutput,
} from './types/filestore.types';

@Injectable()
export class FilestoreService {
  private readonly logger = new Logger(FilestoreService.name);

  constructor(
    private readonly repository: FilestoreRepository,
    @Optional() private readonly eventEmitter?: EventEmitter2,
    @Optional()
    @Inject(FILES_PORT)
    private readonly filesPort?: IFilesPort,
  ) {}

  /**
   * Directly opens a readable stream for a file without passing through HTTP.
   * Used by ClsiService and GitBridgeService to hydrate workspaces with figures, fonts, and packages.
   */
  public async openReadStream(
    projectId: string,
    fileId: string,
  ): Promise<{ file: PageBinaryAsset; stream: Readable }> {
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
    pageId?: string | null,
  ): Promise<StreamPageBinaryAssetOutput> {
    const file = await this.repository.findByProjectAndId(
      projectId,
      fileId,
      pageId,
    );
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
    options?: { syncStructureNode?: boolean; pageId?: string | null },
  ): Promise<PageBinaryAsset> {
    const stream = Readable.from(buffer);
    return await this.uploadFileFromStream(
      projectId,
      name,
      stream,
      mimeType,
      'manuscript-files',
      {
        syncStructureNode: options?.syncStructureNode ?? true,
        pageId: options?.pageId,
      },
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
    options?: { syncStructureNode?: boolean; pageId?: string | null },
  ): Promise<PageBinaryAsset> {
    // Validate filename BEFORE spooling stream or writing to S3/disk storage
    const sanitizedName = PageBinaryAsset.sanitizeFilename(name);

    const candidatePageId = options?.pageId?.trim() || undefined;
    const validCandidatePageId =
      candidatePageId && isUuid(candidatePageId) ? candidatePageId : undefined;
    let effectivePageId = validCandidatePageId;
    if (typeof this.repository.resolvePageId === 'function') {
      effectivePageId = await this.repository.resolvePageId(
        projectId,
        validCandidatePageId,
      );
    }

    const { contentHash, sha256Hex, sizeBytes, dataStream } =
      await this.repository.hashStream(stream);

    let quotaDeltaApplied = 0n;
    let existing: PageBinaryAsset | null = null;
    let acquiredNewBlobId: string | null = null;
    let saved!: PageBinaryAsset;

    try {
      if (sizeBytes > MAX_FILE_SIZE_BYTES) {
        throw new StorageQuotaExceededException(sizeBytes, MAX_FILE_SIZE_BYTES);
      }

      if (
        options?.syncStructureNode !== false &&
        typeof this.repository.assertUploadPathAvailable === 'function'
      ) {
        await this.repository.assertUploadPathAvailable(
          projectId,
          sanitizedName,
          effectivePageId,
        );
      }

      existing = await this.repository.findByProjectAndName(
        projectId,
        sanitizedName,
        effectivePageId,
      );

      // Enforce unified platform Space StorageQuota before writing physical object
      const netBytesDelta =
        BigInt(sizeBytes) - BigInt(existing?.sizeBytes ?? 0);
      if (
        netBytesDelta > 0n &&
        typeof this.filesPort?.reserveQuota === 'function'
      ) {
        await this.filesPort.reserveQuota(projectId, netBytesDelta);
        quotaDeltaApplied = netBytesDelta;
      } else if (
        netBytesDelta < 0n &&
        typeof this.filesPort?.releaseQuota === 'function'
      ) {
        await this.filesPort.releaseQuota(projectId, -netBytesDelta);
        quotaDeltaApplied = netBytesDelta;
      }

      let storageKey = this.repository.buildStorageKey(contentHash);
      let blobExists = await this.repository.checkObjectExists(
        bucketName,
        storageKey.getValue(),
      );

      if (
        !blobExists &&
        typeof this.filesPort?.findBlobByHash === 'function' &&
        sha256Hex &&
        /^[a-f0-9]{64}$/i.test(sha256Hex)
      ) {
        const casHit = await this.filesPort
          .findBlobByHash(sha256Hex)
          .catch(() => null);
        if (casHit?.status === BlobStatus.READY) {
          storageKey = StorageKey.fromRawKey(casHit.s3Key);
          blobExists = true;
        }
      }

      if (blobExists) {
        dataStream.destroy();
        this.logger.log(
          `[CAS Deduplication] Reusing existing blob '${storageKey.getValue()}' for file '${sanitizedName}' in space '${projectId}'. (0 bytes written to storage)`,
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
          `[CAS Write] Stored new blob '${storageKey.getValue()}' (${sizeBytes} bytes) for space '${projectId}'.`,
        );
      }

      // Register or increment reference count in platform StorageBlob CAS ledger
      let resolvedBlobId: string | null = existing?.blobId ?? null;
      const isIdenticalOverwrite = Boolean(
        existing?.blobId && existing.hash.getValue() === contentHash.getValue(),
      );
      if (
        !isIdenticalOverwrite &&
        typeof this.filesPort?.registerUploadedObject === 'function' &&
        sha256Hex &&
        /^[a-f0-9]{64}$/i.test(sha256Hex)
      ) {
        try {
          const casResult = await this.filesPort.registerUploadedObject({
            storageKey: storageKey.getValue(),
            sizeBytes: BigInt(sizeBytes),
            contentHashHex: sha256Hex,
          });
          if (casResult?.blob?.id) {
            resolvedBlobId = casResult.blob.id;
            acquiredNewBlobId = casResult.blob.id;
          }
          if (casResult?.blob?.s3Key) {
            storageKey = StorageKey.fromRawKey(casResult.blob.s3Key);
          }
        } catch (err) {
          this.logger.warn(
            `[CAS Ledger] Failed to register StorageBlob for '${sanitizedName}': ${(err as Error).message}`,
          );
        }
      }

      const targetPageId = effectivePageId ?? existing?.pageId ?? null;
      const fileEntity = PageBinaryAsset.reconstitute({
        id:
          existing?.id ??
          PageBinaryAsset.create({
            projectId,
            pageId: targetPageId,
            blobId: resolvedBlobId,
            name: sanitizedName,
            mimeType: mimeType || 'application/octet-stream',
            sizeBytes,
            hash: contentHash,
            storageKey,
            bucketName,
          }).id,
        projectId,
        pageId: targetPageId,
        blobId: resolvedBlobId,
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

      saved = await this.repository.save(fileEntity, options);

      // Release superseded StorageBlob reference when an existing asset is overwritten with new content
      if (
        existing?.blobId &&
        resolvedBlobId &&
        existing.blobId !== resolvedBlobId &&
        typeof this.filesPort?.releaseBlob === 'function'
      ) {
        await this.filesPort
          .releaseBlob(existing.blobId)
          .catch((err: unknown) => {
            this.logger.warn(
              `[CAS Ledger] Failed to release overwritten blob '${existing?.blobId}': ${(err as Error).message}`,
            );
          });
      }
    } catch (err) {
      if (
        quotaDeltaApplied > 0n &&
        typeof this.filesPort?.releaseQuota === 'function'
      ) {
        await this.filesPort
          .releaseQuota(projectId, quotaDeltaApplied)
          .catch(() => undefined);
      } else if (
        quotaDeltaApplied < 0n &&
        typeof this.filesPort?.reserveQuota === 'function'
      ) {
        await this.filesPort
          .reserveQuota(projectId, -quotaDeltaApplied)
          .catch(() => undefined);
      }
      if (
        acquiredNewBlobId &&
        acquiredNewBlobId !== existing?.blobId &&
        typeof this.filesPort?.releaseBlob === 'function'
      ) {
        await this.filesPort
          .releaseBlob(acquiredNewBlobId)
          .catch(() => undefined);
      }
      throw err;
    } finally {
      dataStream.destroy();
    }

    if (options?.syncStructureNode !== false) {
      const parsedPath = NodePathVo.parse(
        saved.name || 'unnamed.bin',
        'unnamed.bin',
      );
      this.eventEmitter?.emit('pages.file-tree.change', {
        projectId,
        change: {
          action: 'create',
          node: {
            id: saved.id,
            fileId: saved.id,
            ...(saved.pageId ? { pageId: saved.pageId } : {}),
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
    pageId?: string | null,
  ): Promise<GetFileHeadOutput> {
    const file = await this.repository.findByProjectAndId(
      projectId,
      fileId,
      pageId,
    );
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
  ): Promise<PageBinaryAsset> {
    const result = await this.getFileHead(projectId, fileId);
    return result.file;
  }

  /**
   * List all files in a page space.
   */
  public async listFiles(
    projectId: string,
    includeDeleted = false,
    pageId?: string | null,
  ): Promise<PageBinaryAsset[]> {
    return await this.repository.listByProject(
      projectId,
      includeDeleted,
      pageId,
    );
  }

  /**
   * Find file by project ID and relative path / leaf name.
   */
  public async findByProjectAndName(
    projectId: string,
    name: string,
    pageId?: string | null,
  ): Promise<PageBinaryAsset | null> {
    return await this.repository.findByProjectAndName(projectId, name, pageId);
  }

  /**
   * Resolve file by exact path, leaf basename, or implicit LaTeX graphics extension in a single query.
   */
  public async findFileByPathFlexible(
    projectId: string,
    rawPath: string,
    pageId?: string | null,
  ): Promise<PageBinaryAsset | null> {
    return await this.repository.findFileByPathFlexible(
      projectId,
      rawPath,
      pageId,
    );
  }

  /**
   * Soft-deletes (`permanent = false`) or permanently purges (`permanent = true`) a binary file.
   * Soft-delete preserves `FileBlob` CAS ref-count and `SpaceQuota` while restorable in Trash;
   * permanent purge releases `FileBlob` ref-count, decrements `SpaceQuota`, and GCs unreferenced blobs.
   */
  public async deleteFile(
    projectId: string,
    fileId: string,
    permanent = false,
    pageId?: string | null,
  ): Promise<void> {
    const file = await this.repository.findByProjectAndId(
      projectId,
      fileId,
      pageId,
    );
    if (!file || (!permanent && file.deleted)) {
      throw new FileNotFoundException(fileId, projectId);
    }

    if (!permanent) {
      const atomicDeleteResult =
        typeof this.repository.markDeletedIfActive === 'function'
          ? await this.repository.markDeletedIfActive(projectId, fileId, pageId)
          : null;

      if (atomicDeleteResult === false) {
        throw new FileNotFoundException(fileId, projectId);
      }
      if (atomicDeleteResult === true) {
        file.markDeleted();
      } else {
        file.markDeleted();
        await this.repository.save(file);
      }

      this.eventEmitter?.emit('pages.file-tree.change', {
        projectId,
        change: {
          action: 'delete',
          node: {
            id: fileId,
            fileId,
          },
        },
      });
      return;
    }

    // Permanent purge: remove DB row(s), release SpaceQuota and FileBlob CAS ref-count
    let purgedFromDb = false;
    if (typeof this.repository.purge === 'function') {
      purgedFromDb = await this.repository.purge(projectId, fileId, pageId);
    }
    if (!purgedFromDb && !file.deleted) {
      const atomicDeleteResult =
        typeof this.repository.markDeletedIfActive === 'function'
          ? await this.repository.markDeletedIfActive(projectId, fileId, pageId)
          : null;
      if (atomicDeleteResult === true) {
        file.markDeleted();
      } else if (atomicDeleteResult === null) {
        file.markDeleted();
        await this.repository.save(file);
      }
    }

    if (
      file.sizeBytes > 0 &&
      typeof this.filesPort?.releaseQuota === 'function'
    ) {
      await this.filesPort
        .releaseQuota(projectId, BigInt(file.sizeBytes))
        .catch((err: unknown) => {
          this.logger.warn(
            `[Quota] Failed to decrement Space quota for project '${projectId}': ${(err as Error).message}`,
          );
        });
    }

    if (typeof this.filesPort?.releaseBlob === 'function') {
      if (file.blobId) {
        try {
          await this.filesPort.releaseBlob(file.blobId);
        } catch (err) {
          this.logger.warn(
            `[CAS Ledger] Failed to release StorageBlob '${file.blobId}' for '${file.id}': ${(err as Error).message}`,
          );
        }
      } else if (typeof this.filesPort?.findBlobByHash === 'function') {
        const rawHash = file.hash.getValue();
        if (/^[a-f0-9]{64}$/i.test(rawHash)) {
          try {
            const blob = await this.filesPort.findBlobByHash(rawHash);
            if (blob) {
              await this.filesPort.releaseBlob(blob.id);
            }
          } catch (err) {
            this.logger.warn(
              `[CAS Ledger] Failed to release StorageBlob for '${file.id}': ${(err as Error).message}`,
            );
          }
        }
      }
    }

    this.eventEmitter?.emit('pages.file-tree.change', {
      projectId,
      change: {
        action: 'delete',
        node: {
          id: fileId,
          fileId,
        },
      },
    });

    if (typeof this.repository.countReferencesByHash === 'function') {
      const remainingRefs = await this.repository.countReferencesByHash(
        file.hash.getValue(),
      );
      if (remainingRefs === 0 && typeof this.repository.deleteObject === 'function') {
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
    deletedNodes?: Array<{
      fileId?: string | null;
      blobId?: string | null;
      sizeBytes?: number;
      hash?: string | null;
    }>,
  ): Promise<void> {
    if (!fileIds || fileIds.length === 0) return;

    let totalReclaimedBytes = 0n;
    const blobIdsToRelease: string[] = [];
    const hashesToRelease: string[] = [];

    if (deletedNodes && deletedNodes.length > 0) {
      const seenFileIds = new Set<string>();
      const nodesMissingBlob: Array<{
        fileId: string;
        hash?: string | null;
      }> = [];

      for (const n of deletedNodes) {
        if (!n.fileId || seenFileIds.has(n.fileId)) continue;
        seenFileIds.add(n.fileId);
        if (typeof n.sizeBytes === 'number' && n.sizeBytes > 0) {
          totalReclaimedBytes += BigInt(n.sizeBytes);
        }
        if (n.blobId) {
          blobIdsToRelease.push(n.blobId);
        } else {
          nodesMissingBlob.push({ fileId: n.fileId, hash: n.hash });
        }
      }

      if (nodesMissingBlob.length > 0) {
        const missingIds = nodesMissingBlob.map((n) => n.fileId);
        const fetchedById = new Map<string, PageBinaryAsset>();
        if (typeof this.repository.findManyByProjectAndIds === 'function') {
          const batch = await this.repository
            .findManyByProjectAndIds(projectId, missingIds)
            .catch(() => []);
          for (const f of batch) {
            fetchedById.set(f.id, f);
          }
        } else if (typeof this.repository.findByProjectAndId === 'function') {
          for (const id of missingIds) {
            const f = await this.repository
              .findByProjectAndId(projectId, id)
              .catch(() => null);
            if (f) fetchedById.set(f.id, f);
          }
        }

        for (const n of nodesMissingBlob) {
          const f = fetchedById.get(n.fileId);
          if (f?.blobId) {
            blobIdsToRelease.push(f.blobId);
          } else if (
            typeof n.hash === 'string' &&
            /^[a-f0-9]{64}$/i.test(n.hash)
          ) {
            hashesToRelease.push(n.hash);
          }
        }
      }
    } else {
      const uniqueIds = Array.from(new Set(fileIds));
      let files: PageBinaryAsset[] = [];
      if (typeof this.repository.findManyByProjectAndIds === 'function') {
        files = await this.repository
          .findManyByProjectAndIds(projectId, uniqueIds)
          .catch(() => []);
      } else {
        for (const fileId of uniqueIds) {
          const f = await this.repository
            .findByProjectAndId(projectId, fileId)
            .catch(() => null);
          if (f) files.push(f);
        }
      }

      for (const f of files) {
        if (f.sizeBytes > 0) {
          totalReclaimedBytes += BigInt(f.sizeBytes);
        }
        if (f.blobId) {
          blobIdsToRelease.push(f.blobId);
        } else {
          const rawHash = f.hash?.getValue?.();
          if (rawHash && /^[a-f0-9]{64}$/i.test(rawHash)) {
            hashesToRelease.push(rawHash);
          }
        }
      }
    }

    if (
      totalReclaimedBytes > 0n &&
      typeof this.filesPort?.releaseQuota === 'function'
    ) {
      await this.filesPort
        .releaseQuota(projectId, totalReclaimedBytes)
        .catch((err: unknown) => {
          this.logger.warn(
            `[Quota] Failed to decrement bulk Space quota for project '${projectId}': ${(err as Error).message}`,
          );
        });
    }

    if (typeof this.filesPort?.releaseBlob === 'function') {
      for (const blobId of blobIdsToRelease) {
        try {
          await this.filesPort.releaseBlob(blobId);
        } catch {
          // Non-blocking CAS release
        }
      }
      if (typeof this.filesPort?.findBlobByHash === 'function') {
        for (const hex of hashesToRelease) {
          try {
            const blob = await this.filesPort.findBlobByHash(hex);
            if (blob) {
              await this.filesPort.releaseBlob(blob.id);
            }
          } catch {
            // Non-blocking CAS release
          }
        }
      }
    }
  }

  /**
   * Restores a soft-deleted file record in the project (used for Memento/Saga rollback and Trash restore).
   * Note: Soft-delete keeps SpaceQuota and StorageBlob CAS ref-counts intact, so restore is a pure DB flip.
   */
  public async restoreFile(
    projectId: string,
    fileId: string,
  ): Promise<boolean> {
    const file = await this.repository.findByProjectAndId(projectId, fileId);
    if (!file) return false;
    if (!file.deleted) {
      return true;
    }

    if (typeof this.repository.markRestoredIfDeleted === 'function') {
      const wonAtomicRestore = await this.repository.markRestoredIfDeleted(
        projectId,
        fileId,
      );
      if (!wonAtomicRestore) {
        return true;
      }
      file.restore();
    } else {
      file.restore();
      await this.repository.save(file);
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
    pageId?: string | null,
  ): Promise<string | null> {
    const file = await this.repository.findByProjectAndId(
      projectId,
      fileId,
      pageId,
    );
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
      return `/api/v1/pages/spaces/${projectId}/files/${file.id}`;
    }

    return signedUrl;
  }
}
