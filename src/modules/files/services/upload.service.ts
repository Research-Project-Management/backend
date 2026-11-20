import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import * as crypto from 'crypto';
import * as path from 'path';
import {
  DEFAULT_MULTIPART_TTL_HOURS,
  DEFAULT_PRESIGN_SIZE_BYTES,
  DEFAULT_STAGING_TTL_SECONDS,
  MAX_MULTIPART_PARTS,
  MAX_PART_PRESIGN_BATCH,
  MIN_MULTIPART_PART_SIZE_BYTES,
  MULTIPART_LARGE_PART_SIZE_BYTES,
  MULTIPART_LARGE_THRESHOLD_BYTES,
  MULTIPART_MEDIUM_PART_SIZE_BYTES,
  MULTIPART_MEDIUM_THRESHOLD_BYTES,
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
  StorageBlobRecord,
  StoreBufferCasResult,
  UploadFilesInput,
  UploadFilesOutput,
  UploadSessionRecord,
  UploadSessionStatus,
} from '../types/files.type';
import { BlobService } from './blob.service';

/**
 * Unified upload orchestration service covering direct buffer uploads,
 * public image uploads, presigned single-PUT, and resumable multipart uploads.
 */
@Injectable()
export class FilesUploadService {
  private readonly logger = new Logger(FilesUploadService.name);

  constructor(
    @Inject(STORAGE_ADAPTER) private readonly driver: IStorageAdapter,
    private readonly blobService: BlobService,
    private readonly blobRepo: BlobRepository,
    private readonly quotaRepo: QuotaRepository,
    private readonly sessionRepo: SessionRepository,
  ) {}

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
    if (!existingBlob || existingBlob.status !== BlobStatus.READY) return null;
    if (!(await this.blobRepo.hasSpaceAccessToBlob(existingBlob.id, targetSpaceId))) {
      return null;
    }

    await this.quotaRepo.incrementUsage(targetSpaceId, existingBlob.sizeBytes);
    try {
      const updated = await this.blobRepo.incrementRefCount(existingBlob.id);
      if (!updated) throw new NotFoundException('Physical data blob not found in storage');
      return updated;
    } catch (err) {
      await this.quotaRepo.decrementUsage(targetSpaceId, existingBlob.sizeBytes).catch(() => {});
      throw err;
    }
  }

  private async verifyMagicBytesOrCleanup(
    storageKey: string,
    mimeType: string,
    cleanFilename: string,
  ): Promise<void> {
    try {
      const streamRes = await this.driver.getStream(storageKey, { start: 0, end: 511 });
      if (!streamRes?.stream) return;
      const headerBuffer = await streamToBuffer(streamRes.stream);
      if (headerBuffer.length > 0) validateMagicBytes(headerBuffer, mimeType, cleanFilename);
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
  }): Promise<StoreBufferCasResult> {
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
      return await this.blobService.registerUploadedObject({
        storageKey: params.storageKey,
        sizeBytes: params.sizeBytes,
        contentHashHex: params.contentHashHex,
        mimeType: params.mimeType,
        checksumVerified: params.checksumVerified,
      });
    } catch (err) {
      await this.quotaRepo.decrementUsage(params.spaceId, params.sizeBytes).catch(() => {});
      throw err;
    }
  }

  async uploadFile(input: UploadFilesInput): Promise<UploadFilesOutput> {
    if (!input.buffer?.length) throw new BadRequestException('File buffer cannot be empty');
    const cleanFilename = this.validateSafeFilename(input.filename);
    const mimeType = this.resolveMimeType(input.mimeType, cleanFilename, input.buffer);
    validateMagicBytes(input.buffer, mimeType, cleanFilename);

    const targetSpaceId = resolveTargetSpaceId(input.spaceId, input.userId);
    await this.quotaRepo.assertAvailable(targetSpaceId, BigInt(input.buffer.length));
    const { blob, isDeduplicated } = await this.blobService.storeBuffer(input.buffer, mimeType);

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
    const detectedMime = this.resolveMimeType(input.mimeType, cleanFilename, input.buffer);
    if (!detectedMime.startsWith('image/') || detectedMime === 'image/svg+xml') {
      throw new BadRequestException(
        'Public asset uploads only support raster image formats (PNG, JPEG, WebP, GIF)',
      );
    }

    validateMagicBytes(input.buffer, detectedMime, cleanFilename);
    const ext = path.extname(cleanFilename).replace(/[^a-zA-Z0-9.]/g, '').toLowerCase() || '.png';
    const key = `public/avatars/${crypto.randomUUID()}${ext}`;
    await this.driver.put(key, input.buffer, { mimeType: detectedMime, size: input.buffer.length });

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
        throw new NotFoundException('Uploaded object not found or verified in storage backend');
      }
      this.logger.debug(
        `Physical object stat check deferred for ${input.storageKey}: ${(err as Error)?.message}`,
      );
    }

    if (actualSize <= 0n) {
      throw new NotFoundException('Uploaded object is empty or not found in storage backend');
    }

    const validHashHex = this.normalizeSha256Hex(input.contentHash);
    const checksumVerified = Boolean(
      validHashHex &&
      statChecksumSha256 &&
      statChecksumSha256 === Buffer.from(validHashHex, 'hex').toString('base64'),
    );

    const registered = await this.finalizeStagingObject({
      storageKey: input.storageKey,
      spaceId: resolveTargetSpaceId(input.spaceId, input.userId),
      sizeBytes: actualSize,
      mimeType: actualMime,
      validationFilename: cleanFilename,
      contentHashHex: validHashHex,
      checksumVerified,
    });

    return {
      blob: registered.blob,
      fileId: registered.blob.id,
      blobId: registered.blob.id,
      url: getFileContentPath(registered.blob.id),
      filename: cleanFilename,
      size: Number(actualSize),
      sizeBytes: actualSize,
      mimeType: actualMime,
      cleanFilename,
      isDeduplicated: registered.isDeduplicated,
    };
  }

  async initiateMultipart(
    input: InitiateFileMultipartInput,
  ): Promise<InitiateFileMultipartOutput> {
    const cleanFilename = this.validateSafeFilename(input.filename);
    const totalSizeBytes = BigInt(input.totalSize);
    const targetSpaceId = resolveTargetSpaceId(input.spaceId, input.userId);
    await this.quotaRepo.assertAvailable(targetSpaceId, totalSizeBytes);

    const expectedHashHex = this.normalizeSha256Hex(input.expectedHash);
    const dedupBlob = expectedHashHex
      ? await this.tryInstantDedup(expectedHashHex, targetSpaceId).catch((err: unknown) => {
          if (err instanceof BadRequestException) throw err;
          this.logger.debug(
            `Multipart instant CAS lookup fell back to normal upload: ${err instanceof Error ? err.message : String(err)}`,
          );
          return null;
        })
      : null;

    if (dedupBlob) {
      return {
        deduplicated: true,
        blob: dedupBlob,
        sessionId: '',
        uploadId: '',
        storageKey: dedupBlob.s3Key,
        partSize: 0,
        totalParts: 0,
        cleanFilename,
        fileId: dedupBlob.id,
        url: getFileContentPath(dedupBlob.id),
        filename: cleanFilename,
        size: Number(dedupBlob.sizeBytes),
      };
    }

    const basePartSize =
      input.totalSize > MULTIPART_LARGE_THRESHOLD_BYTES
        ? MULTIPART_LARGE_PART_SIZE_BYTES
        : input.totalSize > MULTIPART_MEDIUM_THRESHOLD_BYTES
          ? MULTIPART_MEDIUM_PART_SIZE_BYTES
          : MIN_MULTIPART_PART_SIZE_BYTES;
    const partSize = Math.max(basePartSize, Math.ceil(input.totalSize / MAX_MULTIPART_PARTS));
    const totalParts = Math.max(1, Math.ceil(input.totalSize / partSize));

    const sessionId = crypto.randomUUID();
    const ext = path.extname(cleanFilename).replace(/^\./, '') || 'bin';
    const storageKey = StorageKey.forMultipartStaging(sessionId, ext).value();
    const { uploadId } = await this.driver.initiateMultipartUpload(storageKey, {
      mimeType: input.mimeType,
    });

    await this.sessionRepo.create({
      id: sessionId,
      spaceId: targetSpaceId ?? input.userId,
      userId: input.userId,
      s3UploadId: uploadId,
      s3Key: storageKey,
      filename: cleanFilename,
      mimeType: input.mimeType,
      totalSize: totalSizeBytes,
      partSize,
      expectedHashHex: expectedHashHex ?? null,
      parentId: input.parentId ?? null,
      expiresAt: new Date(Date.now() + DEFAULT_MULTIPART_TTL_HOURS * 3600 * 1000),
    });

    return {
      deduplicated: false,
      sessionId,
      uploadId,
      storageKey,
      partSize,
      totalParts,
      cleanFilename,
    };
  }

  private verifySessionAccess(session: UploadSessionRecord, actor?: FileActorContext): void {
    if (!actor || session.userId === actor.userId) return;
    if (session.spaceId !== session.userId && actor.spaceId && session.spaceId === actor.spaceId) {
      return;
    }
    throw new NotFoundException('Upload session not found');
  }

  private async getValidActiveSession(
    sessionId: string,
    actor?: FileActorContext,
  ): Promise<UploadSessionRecord> {
    const session = await this.sessionRepo.findById(sessionId);
    if (!session || Date.now() > session.expiresAt.getTime()) {
      throw new NotFoundException('Upload session not found or expired');
    }
    this.verifySessionAccess(session, actor);
    if (
      session.status === UploadSessionStatus.ABORTED ||
      session.status === UploadSessionStatus.COMPLETED
    ) {
      throw new BadRequestException(`Upload session has already been ${session.status}`);
    }
    return session;
  }

  private async ensureSessionUploading(session: UploadSessionRecord): Promise<void> {
    if (session.status !== UploadSessionStatus.INITIALIZED) return;
    if (typeof this.sessionRepo.markUploadingIfInitialized === 'function') {
      await this.sessionRepo.markUploadingIfInitialized(session.id);
      return;
    }
    await this.sessionRepo.markStatus(session.id, UploadSessionStatus.UPLOADING);
  }

  async presignMultipartParts(
    sessionId: string,
    partNumbers: number[],
    actor?: FileActorContext,
  ): Promise<MultipartPartUrlItem[]> {
    if (!Array.isArray(partNumbers) || partNumbers.length === 0 || partNumbers.length > MAX_PART_PRESIGN_BATCH) {
      throw new BadRequestException(
        `partNumbers must contain between 1 and ${MAX_PART_PRESIGN_BATCH} part numbers`,
      );
    }

    const session = await this.getValidActiveSession(sessionId, actor);
    const uniqueParts = Array.from(new Set(partNumbers));
    for (const partNumber of uniqueParts) {
      if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > session.totalParts) {
        throw new BadRequestException(
          `Invalid part number ${partNumber}. Expected an integer between 1 and ${session.totalParts}`,
        );
      }
    }

    await this.ensureSessionUploading(session);
    return Promise.all(
      uniqueParts.map(async (partNumber) => ({
        partNumber,
        uploadUrl: await this.driver.getPresignedPartUploadUrl(
          session.s3Key,
          session.s3UploadId,
          partNumber,
          3600,
        ),
      })),
    );
  }

  async completeMultipart(
    input: CompleteFileMultipartInput,
  ): Promise<CompleteFileMultipartOutput> {
    const session = await this.getValidActiveSession(input.sessionId, input.actor);
    const cleanFilename = this.validateSafeFilename(session.filename);
    if (!Array.isArray(input.parts) || input.parts.length === 0) {
      throw new BadRequestException('Parts array cannot be empty');
    }

    await this.driver.completeMultipartUpload(
      session.s3Key,
      session.s3UploadId,
      input.parts.map((p) => ({ partNumber: p.partNumber, eTag: p.eTag })),
    );

    const registered = await this.finalizeStagingObject({
      storageKey: session.s3Key,
      spaceId: resolveTargetSpaceId(session.spaceId, session.userId),
      sizeBytes: session.totalSize,
      mimeType: session.mimeType,
      validationFilename: session.filename,
      contentHashHex: session.expectedHashHex ?? undefined,
      checksumVerified: false,
    });

    const completedSession = await this.sessionRepo.markStatus(
      session.id,
      UploadSessionStatus.COMPLETED,
    );

    return {
      blob: registered.blob,
      session: completedSession,
      isDeduplicated: registered.isDeduplicated,
      fileId: registered.blob.id,
      blobId: registered.blob.id,
      url: getFileContentPath(registered.blob.id),
      filename: cleanFilename,
      size: Number(registered.blob.sizeBytes),
      mimeType: session.mimeType,
    };
  }

  async abortMultipart(sessionId: string, actor?: FileActorContext): Promise<void> {
    const session = await this.sessionRepo.findById(sessionId);
    if (!session) throw new NotFoundException('Upload session not found');
    this.verifySessionAccess(session, actor);
    if (session.status === UploadSessionStatus.COMPLETED) {
      throw new BadRequestException('Cannot abort an already completed upload session');
    }
    if (session.status === UploadSessionStatus.ABORTED) return;

    await this.driver.abortMultipartUpload(session.s3Key, session.s3UploadId).catch(() => {});
    await this.sessionRepo.markStatus(session.id, UploadSessionStatus.ABORTED);
  }

  async cleanupExpiredSessions(limit = 50): Promise<number> {
    const expiredSessions = await this.sessionRepo.findExpiredSessions(new Date(), limit);
    let abortedCount = 0;
    for (const session of expiredSessions) {
      try {
        await this.driver.abortMultipartUpload(session.s3Key, session.s3UploadId);
        await this.sessionRepo.markStatus(session.id, UploadSessionStatus.ABORTED);
        abortedCount++;
      } catch (err: unknown) {
        this.logger.warn(
          `Failed aborting expired session ${session.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return abortedCount;
  }
}
