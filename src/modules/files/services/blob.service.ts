import {
  BadRequestException,
  Injectable,
  Inject,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { Readable } from 'node:stream';
import { GC_CLAIM_LEASE_MINUTES, STORAGE_ADAPTER } from '../files.constant';
import { ContentHash, StorageKey } from '../domain/storage-vo';
import { BlobRepository } from '../repositories/blob.repository';
import { IStorageAdapter } from '../types/adapter.type';
import {
  BlobStatus,
  RegisterUploadedObjectInput,
  StorageBlobRecord,
  StoreBufferCasResult,
} from '../types/files.type';

const MAX_SYNC_STREAM_HASH_BYTES = 100n * 1024n * 1024n;

/**
 * Core binary CAS engine managing physical object deduplication,
 * stream opening, and atomic orphan reclamation.
 */
@Injectable()
export class BlobService {
  private readonly logger = new Logger(BlobService.name);

  constructor(
    @Inject(STORAGE_ADAPTER) private readonly driver: IStorageAdapter,
    private readonly blobRepo: BlobRepository,
  ) {}

  private getBucketName(): string {
    return this.driver.getBucketName?.() || 'flux';
  }

  private isUniqueConstraintError(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    const obj = err as {
      code?: string;
      meta?: { driverAdapterError?: { cause?: { originalCode?: string } } };
    };
    return (
      obj.code === 'P2002' ||
      obj.code === '23505' ||
      String(obj.meta?.driverAdapterError?.cause?.originalCode ?? '') ===
        '23505'
    );
  }

  private deleteObjectQuietly(storageKey: string, label = 'redundant'): void {
    if (typeof this.driver?.delete !== 'function') return;
    Promise.resolve(this.driver.delete(storageKey)).catch((err: unknown) => {
      this.logger.warn(
        `Failed to clean up ${label} object ${storageKey}: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  private async incrementExistingBlob(
    blobId: string,
  ): Promise<StorageBlobRecord> {
    const updated = await this.blobRepo.incrementRefCount(blobId);
    if (!updated) {
      throw new NotFoundException(
        'Physical blob is currently being purged or no longer available',
      );
    }
    return updated;
  }

  async storeBuffer(
    buffer: Buffer,
    mimeType: string,
    onBeforeNewUpload?: (sizeBytes: bigint) => Promise<void>,
  ): Promise<StoreBufferCasResult> {
    const sizeBytes = BigInt(buffer.length);
    const contentHashHex = ContentHash.fromBuffer(buffer).toHex();

    const existingBlob = await this.blobRepo.findByHash(contentHashHex);
    if (existingBlob && existingBlob.status === BlobStatus.READY) {
      if (onBeforeNewUpload) {
        await onBeforeNewUpload(sizeBytes);
      }
      try {
        const updated = await this.incrementExistingBlob(existingBlob.id);
        return { blob: updated, isDeduplicated: true };
      } catch (err) {
        if (!(err instanceof NotFoundException)) throw err;
      }
    }

    if (onBeforeNewUpload) {
      await onBeforeNewUpload(sizeBytes);
    }

    const s3Key = StorageKey.forBlob(contentHashHex).value();
    await this.driver.put(s3Key, buffer, {
      mimeType,
      size: buffer.length,
    });

    try {
      const created = await this.blobRepo.create({
        id: crypto.randomUUID(),
        contentHashHex,
        sizeBytes,
        mimeType: mimeType || 'application/octet-stream',
        checksumVerified: true,
        s3Key,
        s3Bucket: this.getBucketName(),
        status: BlobStatus.READY,
        refCount: 1,
      });
      return { blob: created, isDeduplicated: false };
    } catch (err: unknown) {
      if ((err as { code?: string })?.code === 'P2002') {
        const concurrentBlob = await this.blobRepo.findByHash(contentHashHex);
        if (concurrentBlob) {
          const updated = await this.incrementExistingBlob(concurrentBlob.id);
          return { blob: updated, isDeduplicated: true };
        }
      }
      throw err;
    }
  }

  private async computeStreamSha256Hex(
    storageKey: string,
  ): Promise<string | null> {
    try {
      const res = await this.driver.getStream(storageKey);
      if (!res?.stream) return null;
      const hash = crypto.createHash('sha256');
      for await (const chunk of res.stream) {
        hash.update(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return hash.digest('hex');
    } catch {
      return null;
    }
  }

  async registerUploadedObject(
    input: RegisterUploadedObjectInput,
  ): Promise<StoreBufferCasResult> {
    const cleanupUploadedObject = (keyToDelete: string) => {
      if (typeof this.driver?.delete === 'function') {
        Promise.resolve(this.driver.delete(keyToDelete)).catch(
          (delErr: unknown) => {
            this.logger.warn(
              `Failed to clean up redundant object ${keyToDelete}: ${delErr instanceof Error ? delErr.message : String(delErr)}`,
            );
          },
        );
      }
    };

    const cleanupRedundantUpload = (canonicalKey: string) => {
      if (input.storageKey !== canonicalKey) {
        cleanupUploadedObject(input.storageKey);
      }
    };

    const declaredHex =
      input.contentHashHex && /^[a-f0-9]{64}$/i.test(input.contentHashHex)
        ? input.contentHashHex.toLowerCase()
        : null;

    let resolvedHex: string | null = null;
    let checksumVerified = Boolean(input.checksumVerified);

    if (checksumVerified && declaredHex) {
      resolvedHex = declaredHex;
    } else if (input.sizeBytes <= MAX_SYNC_STREAM_HASH_BYTES) {
      const computedHex = await this.computeStreamSha256Hex(input.storageKey);
      if (declaredHex && computedHex && declaredHex !== computedHex) {
        cleanupUploadedObject(input.storageKey);
        throw new BadRequestException(
          'Content hash mismatch: uploaded file does not match declared SHA-256',
        );
      }
      if (computedHex) {
        resolvedHex = computedHex;
        checksumVerified = true;
      } else if (declaredHex) {
        resolvedHex = declaredHex;
        checksumVerified = false;
      }
    }

    const blobId = crypto.randomUUID();
    const isUnhashedLargeUpload = !resolvedHex;
    const hashHex =
      resolvedHex ||
      crypto.createHash('sha256').update(`unhashed:${blobId}`).digest('hex');

    if (!isUnhashedLargeUpload) {
      const existingBlob = await this.blobRepo.findByHash(hashHex);
      if (existingBlob) {
        if (
          existingBlob.status !== BlobStatus.READY &&
          input.storageKey !== existingBlob.s3Key
        ) {
          const physicalExists = await this.driver
            .stat(existingBlob.s3Key)
            .then(() => true)
            .catch(() => false);
          if (!physicalExists) {
            const { stream, contentLength } = await this.driver.getStream(
              input.storageKey,
            );
            const readable =
              stream instanceof Readable
                ? stream
                : Readable.from(stream as AsyncIterable<Uint8Array>);
            await this.driver.put(existingBlob.s3Key, readable, {
              size: contentLength,
            });
          }
        }
        try {
          const updated = await this.incrementExistingBlob(existingBlob.id);
          cleanupRedundantUpload(existingBlob.s3Key);
          return { blob: updated, isDeduplicated: true };
        } catch (err) {
          if (!(err instanceof NotFoundException)) throw err;
        }
      }
    }

    let finalS3Key = StorageKey.fromString(input.storageKey).value();
    const targetKey = (
      resolvedHex
        ? StorageKey.forBlob(resolvedHex)
        : StorageKey.forUnhashedBlob(blobId)
    ).value();

    if (
      input.storageKey !== targetKey &&
      typeof this.driver?.copy === 'function'
    ) {
      await this.driver.copy(input.storageKey, targetKey);
      finalS3Key = targetKey;
      cleanupRedundantUpload(targetKey);
    }

    try {
      const created = await this.blobRepo.create({
        id: blobId,
        contentHashHex: hashHex,
        sizeBytes: input.sizeBytes,
        mimeType: input.mimeType || 'application/octet-stream',
        checksumVerified,
        s3Key: finalS3Key,
        s3Bucket: this.getBucketName(),
        status: BlobStatus.READY,
        refCount: 1,
      });
      return { blob: created, isDeduplicated: false };
    } catch (err: unknown) {
      if ((err as { code?: string })?.code === 'P2002') {
        const concurrentBlob = await this.blobRepo.findByHash(hashHex);
        if (concurrentBlob) {
          const updated = await this.incrementExistingBlob(concurrentBlob.id);
          cleanupRedundantUpload(concurrentBlob.s3Key);
          return { blob: updated, isDeduplicated: true };
        }
      }
      throw err;
    }
  }

  /**
   * Fast-Finalize path for HTTP upload completion: registers a READY FileBlob
   * pointing to the staging key without synchronous full-stream hashing or S3 copy.
   * Canonical CAS promotion runs asynchronously in the files-finalize-cas worker.
   */
  async registerStagingObjectFast(
    input: RegisterUploadedObjectInput,
  ): Promise<StoreBufferCasResult & { needsAsyncPromotion: boolean }> {
    const normalizedStagingKey = StorageKey.fromString(
      input.storageKey,
    ).value();
    const declaredHex =
      input.contentHashHex && /^[a-f0-9]{64}$/i.test(input.contentHashHex)
        ? input.contentHashHex.toLowerCase()
        : null;

    if (Boolean(input.checksumVerified) && declaredHex) {
      const existingBlob = await this.blobRepo.findByHash(declaredHex);
      if (existingBlob && existingBlob.status === BlobStatus.READY) {
        try {
          const updated = await this.incrementExistingBlob(existingBlob.id);
          if (normalizedStagingKey !== existingBlob.s3Key) {
            this.deleteObjectQuietly(normalizedStagingKey);
          }
          return {
            blob: updated,
            isDeduplicated: true,
            needsAsyncPromotion: false,
          };
        } catch (err) {
          if (!(err instanceof NotFoundException)) throw err;
        }
      }

      const blobId = crypto.randomUUID();
      const canonicalKey = StorageKey.forBlob(declaredHex).value();
      try {
        const created = await this.blobRepo.create({
          id: blobId,
          contentHashHex: declaredHex,
          sizeBytes: input.sizeBytes,
          mimeType: input.mimeType || 'application/octet-stream',
          checksumVerified: true,
          s3Key: normalizedStagingKey,
          s3Bucket: this.getBucketName(),
          status: BlobStatus.READY,
          refCount: 1,
        });
        return {
          blob: created,
          isDeduplicated: false,
          needsAsyncPromotion: normalizedStagingKey !== canonicalKey,
        };
      } catch (err: unknown) {
        if (this.isUniqueConstraintError(err)) {
          const concurrentBlob = await this.blobRepo.findByHash(declaredHex);
          if (concurrentBlob) {
            const updated = await this.incrementExistingBlob(concurrentBlob.id);
            if (normalizedStagingKey !== concurrentBlob.s3Key) {
              this.deleteObjectQuietly(normalizedStagingKey);
            }
            return {
              blob: updated,
              isDeduplicated: true,
              needsAsyncPromotion: false,
            };
          }
        }
        throw err;
      }
    }

    const blobId = crypto.randomUUID();
    const placeholderHashHex = crypto
      .createHash('sha256')
      .update(`unhashed:${blobId}`)
      .digest('hex');

    const created = await this.blobRepo.create({
      id: blobId,
      contentHashHex: placeholderHashHex,
      sizeBytes: input.sizeBytes,
      mimeType: input.mimeType || 'application/octet-stream',
      checksumVerified: false,
      s3Key: normalizedStagingKey,
      s3Bucket: this.getBucketName(),
      status: BlobStatus.READY,
      refCount: 1,
    });

    return {
      blob: created,
      isDeduplicated: false,
      needsAsyncPromotion: true,
    };
  }

  /**
   * Worker-side CAS promotion: streams staging object to compute SHA-256 (if unverified),
   * copies to canonical CAS (or isolated blobs/raw/<p1>/<blobId> on post-facto hash collision),
   * updates FileBlob atomically before scheduling delayed staging object cleanup.
   */
  async promoteStagingBlobToCas(input: {
    blobId: string;
    stagingKey: string;
    declaredHashHex?: string;
  }): Promise<{
    promoted: boolean;
    isolated: boolean;
    finalKey?: string;
    stagingKeyToDelete?: string;
  }> {
    const normalizedStagingKey = StorageKey.fromString(
      input.stagingKey,
    ).value();
    const blob = await this.blobRepo.findById(input.blobId);
    if (
      !blob ||
      blob.status === BlobStatus.DELETED ||
      blob.s3Key !== normalizedStagingKey
    ) {
      return { promoted: false, isolated: false };
    }

    if (blob.checksumVerified) {
      const canonicalKey = StorageKey.forBlob(blob.contentHashHex).value();
      if (normalizedStagingKey === canonicalKey) {
        return { promoted: false, isolated: false };
      }
      await this.driver.copy(normalizedStagingKey, canonicalKey);
      const updated = await this.blobRepo.promoteStorageLocation({
        blobId: blob.id,
        expectedCurrentKey: normalizedStagingKey,
        nextStorageKey: canonicalKey,
        checksumVerified: true,
      });
      if (!updated) {
        return { promoted: false, isolated: false };
      }
      return {
        promoted: true,
        isolated: false,
        finalKey: canonicalKey,
        stagingKeyToDelete: normalizedStagingKey,
      };
    }

    const computedHex = await this.computeStreamSha256Hex(normalizedStagingKey);
    if (!computedHex) {
      let missingPermanently = false;
      try {
        await this.driver.stat(normalizedStagingKey);
      } catch (statErr: unknown) {
        if (statErr instanceof NotFoundException) {
          missingPermanently = true;
        }
      }
      if (missingPermanently) {
        this.logger.error(
          `Staging object ${normalizedStagingKey} missing during CAS promotion for blob ${blob.id}`,
        );
        return { promoted: false, isolated: false };
      }
      throw new Error(
        `Failed to stream staging object ${normalizedStagingKey} for CAS promotion`,
      );
    }

    if (
      input.declaredHashHex &&
      /^[a-f0-9]{64}$/i.test(input.declaredHashHex) &&
      input.declaredHashHex.toLowerCase() !== computedHex
    ) {
      this.logger.warn(
        `CAS declared hash mismatch for blob ${blob.id}: declared=${input.declaredHashHex.toLowerCase()}, actual=${computedHex}. Promoting using actual digest.`,
      );
    }

    const existingByHash = await this.blobRepo.findByHash(computedHex);
    if (!existingByHash || existingByHash.id === blob.id) {
      const canonicalKey = StorageKey.forBlob(computedHex).value();
      await this.driver.copy(normalizedStagingKey, canonicalKey);
      try {
        const updated = await this.blobRepo.promoteStorageLocation({
          blobId: blob.id,
          expectedCurrentKey: normalizedStagingKey,
          nextStorageKey: canonicalKey,
          nextContentHashHex: computedHex,
          checksumVerified: true,
        });
        return updated
          ? {
              promoted: true,
              isolated: false,
              finalKey: canonicalKey,
              stagingKeyToDelete: normalizedStagingKey,
            }
          : { promoted: false, isolated: false };
      } catch (err: unknown) {
        if (!this.isUniqueConstraintError(err)) {
          throw err;
        }
        // Winner already owns canonicalKey; fall through to isolated storage without touching canonicalKey.
      }
    }

    const isolatedKey = StorageKey.forUnhashedBlob(blob.id).value();
    await this.driver.copy(normalizedStagingKey, isolatedKey);
    const updated = await this.blobRepo.promoteStorageLocation({
      blobId: blob.id,
      expectedCurrentKey: normalizedStagingKey,
      nextStorageKey: isolatedKey,
      checksumVerified: true,
    });
    return updated
      ? {
          promoted: true,
          isolated: true,
          finalKey: isolatedKey,
          stagingKeyToDelete: normalizedStagingKey,
        }
      : { promoted: false, isolated: false };
  }

  async openStream(
    blobId: string,
    range?: { start: number; end: number },
  ): Promise<{
    blob: StorageBlobRecord;
    stream: NodeJS.ReadableStream;
    contentLength: number;
    contentRange?: string;
  }> {
    const blob = await this.blobRepo.findById(blobId);
    if (!blob) {
      throw new NotFoundException('Physical storage blob not found');
    }
    const { stream, contentLength, contentRange } = range
      ? await this.driver.getStream(blob.s3Key, range)
      : await this.driver.getStream(blob.s3Key);
    return { blob, stream, contentLength, contentRange };
  }

  async reclaimOrphanBlobs(
    limit = 100,
    options?: { maxBatches?: number; timeBudgetMs?: number },
  ): Promise<number> {
    const staleThreshold = new Date(
      Date.now() - GC_CLAIM_LEASE_MINUTES * 60_000,
    );
    await this.blobRepo.reclaimStuckClaims(staleThreshold).catch(() => 0);

    const maxBatches = Math.max(1, options?.maxBatches ?? 1);
    const timeBudgetMs = options?.timeBudgetMs ?? 45_000;
    const deadline = Date.now() + timeBudgetMs;
    let totalDeleted = 0;

    for (let batchIdx = 0; batchIdx < maxBatches; batchIdx++) {
      if (Date.now() > deadline) break;

      const claimedBlobs = await this.blobRepo.claimOrphanBlobsBatch(
        new Date(),
        limit,
      );
      if (claimedBlobs.length === 0) break;

      totalDeleted += await this.purgeClaimedBatch(claimedBlobs);
      if (claimedBlobs.length < limit) break;
    }

    return totalDeleted;
  }

  private collectDerivativeKeys(blob: StorageBlobRecord): string[] {
    return [
      StorageKey.forDerivative(blob.contentHashHex, 'thumb').value(),
      `thumbnails/${blob.id}.webp`,
    ];
  }

  private async purgeClaimedBatch(
    claimedBlobs: StorageBlobRecord[],
  ): Promise<number> {
    let deletedCount = 0;
    const BATCH_SIZE = 500;

    for (let i = 0; i < claimedBlobs.length; i += BATCH_SIZE) {
      const batch = claimedBlobs.slice(i, i + BATCH_SIZE);
      if (typeof this.driver?.deleteMany === 'function' && batch.length > 1) {
        const allKeys = batch.flatMap((b) => [
          b.s3Key,
          ...this.collectDerivativeKeys(b),
        ]);
        try {
          await this.driver.deleteMany(allKeys);
          await this.blobRepo.deleteMany(batch.map((b) => b.id));
          deletedCount += batch.length;
          continue;
        } catch (batchErr: unknown) {
          this.logger.warn(
            `driver.deleteMany failed on orphan batch, falling back to individual deletes: ${(batchErr as Error)?.message}`,
          );
        }
      }

      for (const b of batch) {
        try {
          await this.driver.delete(b.s3Key);
          await this.blobRepo.delete(b.id);
          if (typeof this.driver?.deleteMany === 'function') {
            this.driver
              .deleteMany(this.collectDerivativeKeys(b))
              .catch(() => undefined);
          }
          deletedCount++;
        } catch (itemErr: unknown) {
          await this.blobRepo.restoreClaimedBlob(b.id).catch(() => undefined);
          this.logger.warn(
            `Failed to reclaim individual orphan blob ${b.id} (${b.s3Key}): ${(itemErr as Error)?.message}`,
          );
        }
      }
    }
    return deletedCount;
  }
}
