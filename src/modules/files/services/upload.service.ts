import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import * as crypto from 'crypto';
import * as path from 'path';
import { DistributedLockService, QUEUES, RedisCacheService } from '@/core';
import {
  DEFAULT_MULTIPART_TTL_HOURS,
  DEFAULT_PRESIGN_SIZE_BYTES,
  DEFAULT_STAGING_TTL_SECONDS,
  FILE_JOBS,
  MAX_MULTIPART_PARTS,
  MAX_PART_PRESIGN_BATCH,
  MIN_MULTIPART_PART_SIZE_BYTES,
  MULTIPART_LARGE_PART_SIZE_BYTES,
  MULTIPART_LARGE_THRESHOLD_BYTES,
  MULTIPART_MEDIUM_PART_SIZE_BYTES,
  MULTIPART_MEDIUM_THRESHOLD_BYTES,
  PRESIGN_COMPLETE_IDEM_TTL_SECONDS,
  STALE_FINALIZING_LEASE_MINUTES,
  STAGING_SWEEP_MIN_AGE_MINUTES,
  STORAGE_ADAPTER,
} from '../files.constant';
import { StorageKey } from '../domain/storage-vo';
import {
  inferMimeType,
  isBlockedExtension,
  resolveTargetSpaceId,
  sanitizeFilename,
  streamToBuffer,
  validateMagicBytes,
} from '../domain/files.policy';
import { BlobRepository } from '../repositories/blob.repository';
import { QuotaRepository } from '../repositories/quota.repository';
import { SessionRepository } from '../repositories/session.repository';
import { IStorageAdapter } from '../types/adapter.type';
import {
  BlobStatus,
  CompleteFileMultipartInput,
  CompleteFileMultipartOutput,
  CompletePresignedFileInput,
  CompletePresignedFileOutput,
  FileActorContext,
  getFileContentPath,
  getFileObjectPath,
  InitiateFileMultipartInput,
  InitiateFileMultipartOutput,
  MultipartPartUrlItem,
  PresignFileUploadInput,
  PresignFileUploadOutput,
  PromoteCasJobData,
  StorageBlobRecord,
  StoreBufferCasResult,
  UploadFilesInput,
  UploadFilesOutput,
  UploadSessionRecord,
  UploadSessionStatus,
} from '../types/files.type';
import { BlobService } from './blob.service';
import { FILES_CACHE_KEYS } from '../files.cache-keys';
import { MultipartUploadFlow } from './multipart-flow';

interface PresignCompleteCache {
  blobId: string;
  cleanFilename: string;
  mimeType: string;
  sizeBytes: string;
  isDeduplicated: boolean;
}

/**
 * Unified upload orchestration service covering direct buffer uploads,
 * public image uploads, presigned single-PUT, and resumable multipart uploads.
 */
@Injectable()
export class FilesUploadService {
  private readonly logger = new Logger(FilesUploadService.name);

  private readonly multipart: MultipartUploadFlow;

  constructor(
    @Inject(STORAGE_ADAPTER) private readonly driver: IStorageAdapter,
    private readonly blobService: BlobService,
    private readonly blobRepo: BlobRepository,
    private readonly quotaRepo: QuotaRepository,
    private readonly sessionRepo: SessionRepository,
    @Optional()
    @InjectQueue(QUEUES.FILE_CAS)
    private readonly finalizeCasQueue?: Queue,
    @Optional()
    private readonly redis?: RedisCacheService,
    @Optional()
    private readonly lockService?: DistributedLockService,
  ) {
    this.multipart = new MultipartUploadFlow({
      driver: this.driver,
      blobRepo: this.blobRepo,
      quotaRepo: this.quotaRepo,
      sessionRepo: this.sessionRepo,
      logger: this.logger,
      hasFinalizeQueue: Boolean(this.finalizeCasQueue),
      validateSafeFilename: (f) => this.validateSafeFilename(f),
      normalizeSha256Hex: (h) => this.normalizeSha256Hex(h),
      tryInstantDedup: (h, s) => this.tryInstantDedup(h, s),
      finalizeStagingObject: (p) => this.finalizeStagingObject(p),
      enqueueCasPromotion: (d) => this.enqueueCasPromotion(d),
      throwFinalizingConflict: (m) => this.throwFinalizingConflict(m),
      buildMultipartOutput: (b, s, f, d) =>
        this.buildMultipartOutput(b, s, f, d),
    });
  }

  initiateMultipart(
    input: InitiateFileMultipartInput,
  ): Promise<InitiateFileMultipartOutput> {
    return this.multipart.initiateMultipart(input);
  }

  presignMultipartParts(
    sessionId: string,
    partNumbers: number[],
    actor?: FileActorContext,
  ): Promise<MultipartPartUrlItem[]> {
    return this.multipart.presignMultipartParts(sessionId, partNumbers, actor);
  }

  completeMultipart(
    input: CompleteFileMultipartInput,
  ): Promise<CompleteFileMultipartOutput> {
    return this.multipart.completeMultipart(input);
  }

  abortMultipart(sessionId: string, actor?: FileActorContext): Promise<void> {
    return this.multipart.abortMultipart(sessionId, actor);
  }

  cleanupExpiredSessions(limit = 50): Promise<number> {
    return this.multipart.cleanupExpiredSessions(limit);
  }

  recoverStaleFinalizingSessions(limit = 50): Promise<number> {
    return this.multipart.recoverStaleFinalizingSessions(limit);
  }

  sweepUnpromotedStagingBlobs(limit = 100): Promise<number> {
    return this.multipart.sweepUnpromotedStagingBlobs(limit);
  }

  private async enqueueCasPromotion(data: PromoteCasJobData): Promise<void> {
    if (!this.finalizeCasQueue) return;
    try {
      await this.finalizeCasQueue.add(FILE_JOBS.PROMOTE_CAS, data, {
        jobId: `promote-cas-${data.blobId}`,
        attempts: 5,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 200,
        removeOnFail: 500,
      });
    } catch (err: unknown) {
      this.logger.error(
        `Failed to enqueue async CAS promotion for blob ${data.blobId} (${data.stagingKey}); maintenance sweep will recover: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private buildCompletePresignedOutput(params: {
    blob: StorageBlobRecord;
    cleanFilename: string;
    actualSize: bigint;
    actualMime: string;
    isDeduplicated: boolean;
  }): CompletePresignedFileOutput {
    return {
      blob: params.blob,
      fileId: params.blob.id,
      blobId: params.blob.id,
      url: getFileContentPath(params.blob.id),
      filename: params.cleanFilename,
      size: Number(params.actualSize),
      sizeBytes: params.actualSize,
      mimeType: params.actualMime,
      cleanFilename: params.cleanFilename,
      isDeduplicated: params.isDeduplicated,
    };
  }

  private buildMultipartOutput(
    blob: StorageBlobRecord,
    session: UploadSessionRecord,
    cleanFilename: string,
    isDeduplicated: boolean,
  ): CompleteFileMultipartOutput {
    return {
      blob,
      session,
      isDeduplicated,
      fileId: blob.id,
      blobId: blob.id,
      url: getFileContentPath(blob.id),
      filename: cleanFilename,
      size: Number(blob.sizeBytes),
      mimeType: blob.mimeType || session.mimeType,
    };
  }

  private async tryReplayPresignComplete(
    idemKey: string,
    cleanFilename: string,
  ): Promise<CompletePresignedFileOutput | null> {
    if (!this.redis) return null;
    try {
      const cached = await this.redis.get<PresignCompleteCache>(idemKey);
      if (!cached?.blobId) return null;
      const blob = await this.blobRepo.findById(cached.blobId);
      if (!blob || blob.status === BlobStatus.DELETED) return null;
      return this.buildCompletePresignedOutput({
        blob,
        cleanFilename: cached.cleanFilename || cleanFilename,
        actualSize: cached.sizeBytes
          ? BigInt(cached.sizeBytes)
          : blob.sizeBytes,
        actualMime: cached.mimeType || blob.mimeType,
        isDeduplicated: Boolean(cached.isDeduplicated),
      });
    } catch {
      return null;
    }
  }

  private throwFinalizingConflict(message: string): never {
    throw new ConflictException({
      statusCode: 409,
      code: 'UPLOAD_FINALIZING',
      message,
      retryAfter: 2,
      details: { retryAfter: 2 },
    });
  }

  private validateSafeFilename(filename: string): string {
    const cleanFilename = sanitizeFilename(filename);
    if (isBlockedExtension(cleanFilename)) {
      throw new BadRequestException(
        'File extension is prohibited for security reasons',
      );
    }
    return cleanFilename;
  }

  private normalizeSha256Hex(rawHash?: string): string | undefined {
    return rawHash && /^[a-f0-9]{64}$/i.test(rawHash)
      ? rawHash.toLowerCase()
      : undefined;
  }

  private resolveMimeType(
    inputMime: string | undefined,
    cleanFilename: string,
    headerBytes: Buffer,
  ): string {
    return inputMime && inputMime !== 'application/octet-stream'
      ? inputMime
      : inferMimeType({ filename: cleanFilename, headerBytes });
  }

  private deleteKeyQuietly(storageKey: string, logFailure = false): void {
    Promise.resolve(this.driver.delete(storageKey)).catch((err: unknown) => {
      if (logFailure) {
        this.logger.warn(
          `Failed to clean up staging object ${storageKey}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
  }

  private async tryInstantDedup(
    hashHex: string | undefined,
    targetSpaceId: string | null,
  ): Promise<StorageBlobRecord | null> {
    if (!hashHex || !targetSpaceId) return null;
    const existingBlob = await this.blobRepo.findByHash(hashHex);
    if (!existingBlob || existingBlob.status !== BlobStatus.READY) {
      this.logger.log('metric=dedup result=miss');
      return null;
    }
    if (
      !(await this.blobRepo.hasSpaceAccessToBlob(
        existingBlob.id,
        targetSpaceId,
      ))
    ) {
      this.logger.log('metric=dedup result=miss reason=no_space_access');
      return null;
    }
    this.logger.log(`metric=dedup result=hit blobId=${existingBlob.id}`);

    await this.quotaRepo.incrementUsage(targetSpaceId, existingBlob.sizeBytes);
    try {
      const updated = await this.blobRepo.incrementRefCount(existingBlob.id);
      if (!updated)
        throw new NotFoundException('Physical data blob not found in storage');
      return updated;
    } catch (err) {
      await this.quotaRepo
        .decrementUsage(targetSpaceId, existingBlob.sizeBytes)
        .catch(() => {});
      throw err;
    }
  }

  private async verifyMagicBytesOrCleanup(
    storageKey: string,
    mimeType: string,
    cleanFilename: string,
  ): Promise<void> {
    try {
      const streamRes = await this.driver.getStream(storageKey, {
        start: 0,
        end: 511,
      });
      if (!streamRes?.stream) return;
      const headerBuffer = await streamToBuffer(streamRes.stream);
      if (headerBuffer.length > 0)
        validateMagicBytes(headerBuffer, mimeType, cleanFilename);
    } catch (err: unknown) {
      if (err instanceof BadRequestException) {
        this.deleteKeyQuietly(storageKey);
        throw err;
      }
    }
  }

  private async finalizeStagingObject(params: {
    storageKey: string;
    spaceId: string | null;
    sizeBytes: bigint;
    mimeType: string;
    validationFilename: string;
    contentHashHex?: string;
    checksumVerified: boolean;
  }): Promise<StoreBufferCasResult & { needsAsyncPromotion: boolean }> {
    await this.verifyMagicBytesOrCleanup(
      params.storageKey,
      params.mimeType,
      params.validationFilename,
    );
    try {
      await this.quotaRepo.incrementUsage(params.spaceId, params.sizeBytes);
    } catch (quotaErr) {
      this.deleteKeyQuietly(params.storageKey, true);
      throw quotaErr;
    }
    try {
      return await this.blobService.registerStagingObjectFast({
        storageKey: params.storageKey,
        sizeBytes: params.sizeBytes,
        contentHashHex: params.contentHashHex,
        mimeType: params.mimeType,
        checksumVerified: params.checksumVerified,
      });
    } catch (err) {
      await this.quotaRepo
        .decrementUsage(params.spaceId, params.sizeBytes)
        .catch(() => {});
      throw err;
    }
  }

  async uploadFile(input: UploadFilesInput): Promise<UploadFilesOutput> {
    if (!input.buffer?.length)
      throw new BadRequestException('File buffer cannot be empty');
    const cleanFilename = this.validateSafeFilename(input.filename);
    const mimeType = this.resolveMimeType(
      input.mimeType,
      cleanFilename,
      input.buffer,
    );
    validateMagicBytes(input.buffer, mimeType, cleanFilename);

    const targetSpaceId = resolveTargetSpaceId(input.spaceId, input.userId);
    await this.quotaRepo.assertAvailable(
      targetSpaceId,
      BigInt(input.buffer.length),
    );
    const { blob, isDeduplicated } = await this.blobService.storeBuffer(
      input.buffer,
      mimeType,
    );

    try {
      await this.quotaRepo.incrementUsage(targetSpaceId, blob.sizeBytes);
      if (input.ownerType && input.ownerId && targetSpaceId) {
        await this.blobRepo.attachRef({
          blobId: blob.id,
          spaceId: targetSpaceId,
          ownerType: input.ownerType,
          ownerId: input.ownerId,
          sizeBytes: blob.sizeBytes,
        });
      }
    } catch (err) {
      await this.blobRepo.decrementRefCount(blob.id).catch(() => {});
      throw err;
    }

    return {
      fileId: blob.id,
      blobId: blob.id,
      url: getFileContentPath(blob.id),
      path: blob.s3Key,
      filename: cleanFilename,
      size: Number(blob.sizeBytes),
      mimeType,
      isDeduplicated,
    };
  }

  async uploadPublicImage(input: {
    buffer: Buffer;
    filename: string;
    mimeType?: string;
  }): Promise<{ key: string; url: string; mimeType: string; size: number }> {
    const cleanFilename = sanitizeFilename(input.filename);
    const detectedMime = this.resolveMimeType(
      input.mimeType,
      cleanFilename,
      input.buffer,
    );
    if (
      !detectedMime.startsWith('image/') ||
      detectedMime === 'image/svg+xml'
    ) {
      throw new BadRequestException(
        'Public asset uploads only support raster image formats (PNG, JPEG, WebP, GIF)',
      );
    }

    validateMagicBytes(input.buffer, detectedMime, cleanFilename);
    const ext =
      path
        .extname(cleanFilename)
        .replace(/[^a-zA-Z0-9.]/g, '')
        .toLowerCase() || '.png';
    const key = `public/avatars/${crypto.randomUUID()}${ext}`;
    await this.driver.put(key, input.buffer, {
      mimeType: detectedMime,
      size: input.buffer.length,
    });

    return {
      key,
      url: getFileObjectPath(key),
      mimeType: detectedMime,
      size: input.buffer.length,
    };
  }

  async presignUpload(
    input: PresignFileUploadInput,
  ): Promise<PresignFileUploadOutput> {
    const cleanFilename = this.validateSafeFilename(input.filename);
    const effectiveSizeBytes = input.sizeBytes ?? DEFAULT_PRESIGN_SIZE_BYTES;
    const targetSpaceId = resolveTargetSpaceId(input.spaceId, input.userId);
    await this.quotaRepo.assertAvailable(
      targetSpaceId,
      BigInt(effectiveSizeBytes),
    );

    const validHashHex = this.normalizeSha256Hex(input.contentHash);
    const dedupBlob = await this.tryInstantDedup(validHashHex, targetSpaceId);
    if (dedupBlob) {
      return {
        deduplicated: true,
        blob: dedupBlob,
        storageKey: dedupBlob.s3Key,
        cleanFilename,
        expiresIn: 0,
        fileUuid: dedupBlob.id,
        uploadUrl: '',
        fileId: dedupBlob.id,
        url: getFileContentPath(dedupBlob.id),
        filename: cleanFilename,
        size: Number(dedupBlob.sizeBytes),
        mimeType: dedupBlob.mimeType || input.mimeType,
      };
    }

    const fileUuid = crypto.randomUUID();
    const ext = path.extname(cleanFilename).replace(/^\./, '') || 'bin';
    const storageKey = StorageKey.forStaging(
      input.userId,
      fileUuid,
      ext,
    ).value();
    const checksumSha256Base64 = validHashHex
      ? Buffer.from(validHashHex, 'hex').toString('base64')
      : undefined;

    const uploadUrl = await this.driver.getPresignedUploadUrl(storageKey, {
      mimeType: input.mimeType,
      sizeBytes: effectiveSizeBytes,
      expiresInSeconds: DEFAULT_STAGING_TTL_SECONDS,
      checksumSha256Base64,
    });

    return {
      deduplicated: false,
      uploadUrl,
      storageKey,
      fileUuid,
      cleanFilename,
      expiresIn: DEFAULT_STAGING_TTL_SECONDS,
    };
  }

  async completePresignedUpload(
    input: CompletePresignedFileInput,
  ): Promise<CompletePresignedFileOutput> {
    const hasValidPrefix =
      input.storageKey.startsWith(`uploads/staging/${input.userId}/`) ||
      input.storageKey.startsWith(`uploads/${input.userId}/`);
    if (!hasValidPrefix) {
      throw new ForbiddenException('Invalid storage key ownership');
    }

    const cleanFilename = this.validateSafeFilename(input.filename);
    const targetSpaceId = resolveTargetSpaceId(input.spaceId, input.userId);
    const spaceScope = targetSpaceId ?? input.userId;
    const keyDigest = crypto
      .createHash('sha256')
      .update(`${spaceScope}:${input.storageKey}`)
      .digest('hex')
      .slice(0, 32);
    const idemKey = FILES_CACHE_KEYS.presignCompleteIdempotency(keyDigest);
    const lockResource = `files:complete:${keyDigest}`;

    const initialReplay = await this.tryReplayPresignComplete(
      idemKey,
      cleanFilename,
    );
    if (initialReplay) {
      return initialReplay;
    }

    let lockToken: string | null = null;
    if (this.lockService) {
      lockToken = await this.lockService.acquireLock(lockResource, 30_000);
      if (!lockToken) {
        const concurrentReplay = await this.tryReplayPresignComplete(
          idemKey,
          cleanFilename,
        );
        if (concurrentReplay) {
          return concurrentReplay;
        }
        this.throwFinalizingConflict(
          'Presigned upload is currently finalizing. Please retry shortly.',
        );
      }
    }

    try {
      const lockedReplay = await this.tryReplayPresignComplete(
        idemKey,
        cleanFilename,
      );
      if (lockedReplay) {
        return lockedReplay;
      }

      const existingByKey =
        typeof this.blobRepo.findByStorageKey === 'function'
          ? await this.blobRepo.findByStorageKey(input.storageKey)
          : null;
      if (existingByKey && existingByKey.status !== BlobStatus.DELETED) {
        const cachePayload: PresignCompleteCache = {
          blobId: existingByKey.id,
          cleanFilename,
          mimeType: existingByKey.mimeType,
          sizeBytes: existingByKey.sizeBytes.toString(),
          isDeduplicated: false,
        };
        await this.redis
          ?.set(idemKey, cachePayload, PRESIGN_COMPLETE_IDEM_TTL_SECONDS)
          .catch(() => {});
        return this.buildCompletePresignedOutput({
          blob: existingByKey,
          cleanFilename,
          actualSize: existingByKey.sizeBytes,
          actualMime: existingByKey.mimeType,
          isDeduplicated: false,
        });
      }

      let actualSize = input.sizeBytes ? BigInt(input.sizeBytes) : 0n;
      let actualMime = input.mimeType || 'application/octet-stream';
      let statChecksumSha256: string | undefined;

      try {
        const stat = await this.driver.stat(input.storageKey);
        if (stat && stat.size > 0) {
          actualSize = BigInt(stat.size);
          statChecksumSha256 = stat.checksumSha256;
          if (stat.mimeType && stat.mimeType !== 'application/octet-stream') {
            actualMime = stat.mimeType;
          }
        }
      } catch (err: unknown) {
        if (err instanceof NotFoundException) {
          throw new NotFoundException(
            'Uploaded object not found or verified in storage backend',
          );
        }
        this.logger.debug(
          `Physical object stat check deferred for ${input.storageKey}: ${(err as Error)?.message}`,
        );
      }

      if (actualSize <= 0n) {
        throw new NotFoundException(
          'Uploaded object is empty or not found in storage backend',
        );
      }

      const validHashHex = this.normalizeSha256Hex(input.contentHash);
      const checksumVerified = Boolean(
        validHashHex &&
        statChecksumSha256 &&
        statChecksumSha256 ===
          Buffer.from(validHashHex, 'hex').toString('base64'),
      );

      const registered = await this.finalizeStagingObject({
        storageKey: input.storageKey,
        spaceId: targetSpaceId,
        sizeBytes: actualSize,
        mimeType: actualMime,
        validationFilename: cleanFilename,
        contentHashHex: validHashHex,
        checksumVerified,
      });

      if (registered.needsAsyncPromotion) {
        await this.enqueueCasPromotion({
          blobId: registered.blob.id,
          stagingKey: input.storageKey,
          declaredHashHex: validHashHex,
        });
      }

      if (this.redis) {
        const cachePayload: PresignCompleteCache = {
          blobId: registered.blob.id,
          cleanFilename,
          mimeType: actualMime,
          sizeBytes: actualSize.toString(),
          isDeduplicated: registered.isDeduplicated,
        };
        await this.redis
          .set(idemKey, cachePayload, PRESIGN_COMPLETE_IDEM_TTL_SECONDS)
          .catch(() => {});
      }

      return this.buildCompletePresignedOutput({
        blob: registered.blob,
        cleanFilename,
        actualSize,
        actualMime,
        isDeduplicated: registered.isDeduplicated,
      });
    } finally {
      if (lockToken && this.lockService) {
        await this.lockService
          .releaseLock(lockResource, lockToken)
          .catch(() => {});
      }
    }
  }
}
