import { Injectable, Inject, Logger, NotFoundException } from '@nestjs/common';
import * as crypto from 'crypto';
import { Readable } from 'node:stream';
import { STORAGE_ADAPTER, STORAGE_BLOB_REPOSITORY } from '../files.constant';
import {
  BlobStatus,
  ContentHash,
  StorageBlob,
  StorageKey,
} from '../domain/blob.domain';
import { IBlobRepository } from '../repositories/blob.repository';
import {
  CompletedPart,
  IStorageAdapter,
  StorageLifecycleConfiguration,
  StorageObjectMetadata,
} from '../types/adapter.type';
import {
  RegisterUploadedObjectInput,
  StoreBufferCasResult,
} from '../types/files.type';

export type { RegisterUploadedObjectInput, StoreBufferCasResult };

/**
 * Core binary CAS service managing physical object reads/writes,
 * SHA-256 deduplication, reference counting, and atomic orphan reclamation.
 */
@Injectable()
export class BlobService {
  private readonly logger = new Logger(BlobService.name);
  private readonly defaultBucket = process.env.R2_BUCKET_NAME || 'flux';

  constructor(
    @Inject(STORAGE_ADAPTER) private readonly driver: IStorageAdapter,
    @Inject(STORAGE_BLOB_REPOSITORY)
    private readonly blobRepo: IBlobRepository,
  ) {}

  private async incrementExistingBlob(blob: StorageBlob): Promise<StorageBlob> {
    const prevCount = blob.refCount;
    const updated = await this.blobRepo.incrementRefCount(blob.id);
    if (!updated) {
      throw new NotFoundException(
        'Physical blob is currently being purged or no longer available',
      );
    }
    if (blob.refCount === prevCount) {
      blob.incrementRef();
    }
    return updated;
  }

  async storeBuffer(
    buffer: Buffer,
    mimeType: string,
    onBeforeNewUpload?: (sizeBytes: bigint) => Promise<void>,
  ): Promise<StoreBufferCasResult> {
    const sizeBytes = BigInt(buffer.length);
    const contentHash = ContentHash.fromBuffer(buffer);
    const hashHex = contentHash.toHex();

    const existingBlob = await this.blobRepo.findByHash(contentHash);
    if (existingBlob && existingBlob.isReady()) {
      if (onBeforeNewUpload) {
        await onBeforeNewUpload(sizeBytes);
      }
      try {
        const updated = await this.incrementExistingBlob(existingBlob);
        return { blob: updated, isDeduplicated: true };
      } catch (err) {
        if (!(err instanceof NotFoundException)) throw err;
      }
    }

    if (onBeforeNewUpload) {
      await onBeforeNewUpload(sizeBytes);
    }

    const s3Key = StorageKey.forBlob(hashHex);
    await this.driver.put(s3Key.value(), buffer, {
      mimeType,
      size: buffer.length,
    });

    const newBlob = new StorageBlob({
      id: crypto.randomUUID(),
      contentHash,
      sizeBytes,
      s3Key,
      s3Bucket: this.defaultBucket,
      status: BlobStatus.READY,
      refCount: 1,
    });
    try {
      await this.blobRepo.create(newBlob);
      return { blob: newBlob, isDeduplicated: false };
    } catch (err: unknown) {
      if ((err as { code?: string })?.code === 'P2002') {
        const concurrentBlob = await this.blobRepo.findByHash(contentHash);
        if (concurrentBlob) {
          const updated = await this.incrementExistingBlob(concurrentBlob);
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
    let resolvedHex =
      input.contentHashHex && /^[a-f0-9]{64}$/i.test(input.contentHashHex)
        ? input.contentHashHex.toLowerCase()
        : null;

    if (!resolvedHex && input.sizeBytes <= 100n * 1024n * 1024n) {
      resolvedHex = await this.computeStreamSha256Hex(input.storageKey);
    }

    const hashHex =
      resolvedHex ||
      crypto
        .createHash('sha256')
        .update(`${input.storageKey}:${input.sizeBytes}`)
        .digest('hex');
    const contentHash = ContentHash.fromHex(hashHex);

    const cleanupRedundantUpload = (canonicalKey: string) => {
      if (
        input.storageKey !== canonicalKey &&
        typeof this.driver?.delete === 'function'
      ) {
        Promise.resolve(this.driver.delete(input.storageKey)).catch(
          (delErr: unknown) => {
            this.logger.warn(
              `Failed to clean up redundant object ${input.storageKey}: ${delErr instanceof Error ? delErr.message : String(delErr)}`,
            );
          },
        );
      }
    };

    const existingBlob = await this.blobRepo.findByHash(contentHash);
    if (existingBlob) {
      if (
        !existingBlob.isReady() &&
        input.storageKey !== existingBlob.s3Key.value()
      ) {
        const physicalExists = await this.driver
          .stat(existingBlob.s3Key.value())
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
          await this.driver.put(existingBlob.s3Key.value(), readable, {
            size: contentLength,
          });
        }
      }
      try {
        const updated = await this.incrementExistingBlob(existingBlob);
        cleanupRedundantUpload(existingBlob.s3Key.value());
        return { blob: updated, isDeduplicated: true };
      } catch (err) {
        if (!(err instanceof NotFoundException)) throw err;
      }
    }

    let finalS3Key = StorageKey.fromString(input.storageKey);
    if (resolvedHex) {
      const canonicalKey = StorageKey.forBlob(resolvedHex).value();
      if (
        input.storageKey !== canonicalKey &&
        typeof this.driver?.copy === 'function'
      ) {
        await this.driver.copy(input.storageKey, canonicalKey);
        finalS3Key = StorageKey.forBlob(resolvedHex);
        cleanupRedundantUpload(canonicalKey);
      }
    }

    const blob = new StorageBlob({
      id: crypto.randomUUID(),
      contentHash,
      sizeBytes: input.sizeBytes,
      s3Key: finalS3Key,
      s3Bucket: this.defaultBucket,
      status: BlobStatus.READY,
      refCount: 1,
    });
    try {
      await this.blobRepo.create(blob);
      return { blob, isDeduplicated: false };
    } catch (err: unknown) {
      if ((err as { code?: string })?.code === 'P2002') {
        const concurrentBlob = await this.blobRepo.findByHash(contentHash);
        if (concurrentBlob) {
          const updated = await this.incrementExistingBlob(concurrentBlob);
          cleanupRedundantUpload(concurrentBlob.s3Key.value());
          return { blob: updated, isDeduplicated: true };
        }
      }
      throw err;
    }
  }

  async acquireBlob(blobId: string): Promise<StorageBlob | null> {
    return this.blobRepo.incrementRefCount(blobId);
  }

  async releaseBlob(blobId: string): Promise<void> {
    await this.blobRepo.decrementRefCount(blobId);
  }

  async openStream(
    blobId: string,
    range?: { start: number; end: number },
  ): Promise<{
    blob: StorageBlob;
    stream: NodeJS.ReadableStream;
    contentLength: number;
    contentRange?: string;
  }> {
    const blob = await this.blobRepo.findById(blobId);
    if (!blob) {
      throw new NotFoundException('Physical storage blob not found');
    }
    const { stream, contentLength, contentRange } = range
      ? await this.driver.getStream(blob.s3Key.value(), range)
      : await this.driver.getStream(blob.s3Key.value());
    return { blob, stream, contentLength, contentRange };
  }

  async put(
    key: string,
    data: Buffer | Readable,
    options?: { mimeType?: string; size?: number },
  ): Promise<void> {
    return this.driver.put(key, data, options);
  }

  async getStream(key: string, range?: { start: number; end: number }) {
    return this.driver.getStream(key, range);
  }

  async stat(key: string): Promise<StorageObjectMetadata> {
    return this.driver.stat(key);
  }

  async delete(key: string): Promise<void> {
    return this.driver.delete(key);
  }

  async deleteMany(keys: string[]): Promise<void> {
    return this.driver.deleteMany(keys);
  }

  async exists(key: string): Promise<boolean> {
    return this.driver.exists(key);
  }

  async getPresignedUploadUrl(
    key: string,
    options: {
      mimeType: string;
      expiresInSeconds?: number;
      sizeBytes?: number;
    },
  ): Promise<string> {
    return this.driver.getPresignedUploadUrl(key, options);
  }

  async getPresignedDownloadUrl(
    key: string,
    options: { expiresInSeconds?: number; filename?: string },
  ): Promise<string> {
    return this.driver.getPresignedDownloadUrl(key, options);
  }

  async initiateMultipartUpload(
    key: string,
    options: { mimeType: string },
  ): Promise<{ uploadId: string }> {
    return this.driver.initiateMultipartUpload(key, options);
  }

  async getPresignedPartUploadUrl(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresInSeconds?: number,
  ): Promise<string> {
    return this.driver.getPresignedPartUploadUrl(
      key,
      uploadId,
      partNumber,
      expiresInSeconds,
    );
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: CompletedPart[],
  ): Promise<{ location?: string; eTag?: string }> {
    return this.driver.completeMultipartUpload(key, uploadId, parts);
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    return this.driver.abortMultipartUpload(key, uploadId);
  }

  async applyLifecycleRules(
    config?: StorageLifecycleConfiguration,
  ): Promise<void> {
    await this.driver.applyLifecycleRules(config);
  }

  async getLifecycleRules(): Promise<StorageLifecycleConfiguration | null> {
    return this.driver.getLifecycleRules();
  }

  async findBlobById(id: string): Promise<StorageBlob | null> {
    return this.blobRepo.findById(id);
  }

  async incrementBlobRef(blobId: string): Promise<StorageBlob> {
    const updated = await this.blobRepo.incrementRefCount(blobId);
    if (!updated) {
      throw new NotFoundException('Physical data blob not found in storage');
    }
    return updated;
  }

  async findBlobByHash(hash: ContentHash): Promise<StorageBlob | null> {
    return this.blobRepo.findByHash(hash);
  }

  async reclaimOrphanBlobs(limit = 100): Promise<number> {
    const now = new Date();
    const deadBlobs = await this.blobRepo.findTombstonedBlobs(now, limit);
    if (deadBlobs.length === 0) return 0;

    let claimedBlobs: StorageBlob[] = [];
    const usesAtomicClaim =
      typeof this.blobRepo.claimBlobForPurge === 'function';

    if (usesAtomicClaim) {
      for (const candidate of deadBlobs) {
        const claimed = await this.blobRepo.claimBlobForPurge!(
          candidate.id,
          now,
        );
        if (claimed) {
          claimedBlobs.push(candidate);
        }
      }
    } else {
      claimedBlobs = deadBlobs;
    }

    if (claimedBlobs.length === 0) return 0;

    let deletedCount = 0;
    const BATCH_SIZE = 500;
    for (let i = 0; i < claimedBlobs.length; i += BATCH_SIZE) {
      const batch = claimedBlobs.slice(i, i + BATCH_SIZE);
      const keys = batch.map((b) => b.s3Key.value());
      if (typeof this.driver?.deleteMany === 'function' && batch.length > 1) {
        try {
          await this.driver.deleteMany(keys);
          for (const b of batch) {
            await this.blobRepo.delete(b.id).catch((delErr: unknown) => {
              this.logger.warn(
                `Failed to delete orphan blob record ${b.id}: ${delErr instanceof Error ? delErr.message : String(delErr)}`,
              );
            });
            deletedCount++;
          }
          continue;
        } catch (batchErr: unknown) {
          this.logger.warn(
            `driver.deleteMany failed on orphan batch, falling back to individual deletes: ${(batchErr as Error)?.message}`,
          );
        }
      }
      for (const b of batch) {
        try {
          await this.driver.delete(b.s3Key.value());
          await this.blobRepo.delete(b.id);
          deletedCount++;
        } catch (itemErr: unknown) {
          if (
            usesAtomicClaim &&
            typeof this.blobRepo.restoreClaimedBlob === 'function'
          ) {
            await this.blobRepo.restoreClaimedBlob(b.id).catch(() => undefined);
          }
          this.logger.warn(
            `Failed to reclaim individual orphan blob ${b.id} (${b.s3Key.value()}): ${(itemErr as Error)?.message}`,
          );
        }
      }
    }
    return deletedCount;
  }
}
