import {
  BadRequestException,
  ConflictException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import * as crypto from 'crypto';
import * as path from 'path';
import {
  DEFAULT_MULTIPART_TTL_HOURS,
  MAX_MULTIPART_PARTS,
  MAX_PART_PRESIGN_BATCH,
  MIN_MULTIPART_PART_SIZE_BYTES,
  MULTIPART_LARGE_PART_SIZE_BYTES,
  MULTIPART_LARGE_THRESHOLD_BYTES,
  MULTIPART_MEDIUM_PART_SIZE_BYTES,
  MULTIPART_MEDIUM_THRESHOLD_BYTES,
  STALE_FINALIZING_LEASE_MINUTES,
  STAGING_SWEEP_MIN_AGE_MINUTES,
} from '../files.constant';
import { StorageKey } from '../domain/storage.vo';
import { resolveTargetSpaceId } from '../domain/files.policy';
import { BlobRepository } from '../repositories/blob.repository';
import { QuotaRepository } from '../repositories/quota.repository';
import { SessionRepository } from '../repositories/session.repository';
import { IStorageAdapter } from '../types/adapter.type';
import {
  BlobStatus,
  CompleteFileMultipartInput,
  CompleteFileMultipartOutput,
  FileActorContext,
  getFileContentPath,
  InitiateFileMultipartInput,
  InitiateFileMultipartOutput,
  MultipartPartUrlItem,
  PromoteCasJobData,
  StorageBlobRecord,
  StoreBufferCasResult,
  UploadSessionRecord,
  UploadSessionStatus,
} from '../types/files.type';

/** Collaborators the multipart flow borrows from FilesUploadService. */
export interface MultipartFlowHost {
  readonly driver: IStorageAdapter;
  readonly blobRepo: BlobRepository;
  readonly quotaRepo: QuotaRepository;
  readonly sessionRepo: SessionRepository;
  readonly logger: Pick<Logger, 'warn' | 'debug'>;
  readonly hasFinalizeQueue: boolean;
  validateSafeFilename(filename: string): string;
  normalizeSha256Hex(rawHash?: string): string | undefined;
  tryInstantDedup(
    hashHex: string | undefined,
    targetSpaceId: string | null,
  ): Promise<StorageBlobRecord | null>;
  finalizeStagingObject(params: {
    storageKey: string;
    spaceId: string | null;
    sizeBytes: bigint;
    mimeType: string;
    validationFilename: string;
    contentHashHex?: string;
    checksumVerified: boolean;
  }): Promise<StoreBufferCasResult & { needsAsyncPromotion: boolean }>;
  enqueueCasPromotion(data: PromoteCasJobData): Promise<void>;
  throwFinalizingConflict(message: string): never;
  buildMultipartOutput(
    blob: StorageBlobRecord,
    session: UploadSessionRecord,
    cleanFilename: string,
    isDeduplicated: boolean,
  ): CompleteFileMultipartOutput;
}

/**
 * Multipart session lifecycle (initiate / part URLs / atomic complete / abort)
 * plus session & staging maintenance. Composed by FilesUploadService.
 */
export class MultipartUploadFlow {
  constructor(private readonly h: MultipartFlowHost) {}
  async initiateMultipart(
    input: InitiateFileMultipartInput,
  ): Promise<InitiateFileMultipartOutput> {
    const cleanFilename = this.h.validateSafeFilename(input.filename);
    const totalSizeBytes = BigInt(input.totalSize);
    const targetSpaceId = resolveTargetSpaceId(input.spaceId, input.userId);
    await this.h.quotaRepo.assertAvailable(targetSpaceId, totalSizeBytes, {
      userId: input.userId,
      enforceSessionCap: true,
    });

    const expectedHashHex = this.h.normalizeSha256Hex(input.expectedHash);
    const dedupBlob = expectedHashHex
      ? await this.h
          .tryInstantDedup(expectedHashHex, targetSpaceId)
          .catch((err: unknown) => {
            if (err instanceof BadRequestException) throw err;
            this.h.logger.debug(
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
    const partSize = Math.max(
      basePartSize,
      Math.ceil(input.totalSize / MAX_MULTIPART_PARTS),
    );
    const totalParts = Math.max(1, Math.ceil(input.totalSize / partSize));

    const sessionId = crypto.randomUUID();
    const ext = path.extname(cleanFilename).replace(/^\./, '') || 'bin';
    const storageKey = StorageKey.forMultipartStaging(sessionId, ext).value();
    const { uploadId } = await this.h.driver.initiateMultipartUpload(
      storageKey,
      {
        mimeType: input.mimeType,
      },
    );

    await this.h.sessionRepo.create({
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
      expiresAt: new Date(
        Date.now() + DEFAULT_MULTIPART_TTL_HOURS * 3600 * 1000,
      ),
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

  private verifySessionAccess(
    session: UploadSessionRecord,
    actor?: FileActorContext,
  ): void {
    if (!actor || session.userId === actor.userId) return;
    if (
      session.spaceId !== session.userId &&
      actor.spaceId &&
      session.spaceId === actor.spaceId
    ) {
      return;
    }
    throw new NotFoundException('Upload session not found');
  }

  private async getValidActiveSession(
    sessionId: string,
    actor?: FileActorContext,
  ): Promise<UploadSessionRecord> {
    const session = await this.h.sessionRepo.findById(sessionId);
    if (!session || Date.now() > session.expiresAt.getTime()) {
      throw new NotFoundException('Upload session not found or expired');
    }
    this.verifySessionAccess(session, actor);
    if (session.status === UploadSessionStatus.FINALIZING) {
      this.h.throwFinalizingConflict(
        'Upload session is currently finalizing. Please retry shortly.',
      );
    }
    if (
      session.status === UploadSessionStatus.ABORTED ||
      session.status === UploadSessionStatus.COMPLETED ||
      session.status === UploadSessionStatus.EXPIRED
    ) {
      throw new BadRequestException(
        `Upload session has already been ${session.status}`,
      );
    }
    return session;
  }

  private async ensureSessionUploading(
    session: UploadSessionRecord,
  ): Promise<void> {
    if (session.status !== UploadSessionStatus.INITIALIZED) return;
    if (typeof this.h.sessionRepo.markUploadingIfInitialized === 'function') {
      await this.h.sessionRepo.markUploadingIfInitialized(session.id);
      return;
    }
    await this.h.sessionRepo.markStatus(
      session.id,
      UploadSessionStatus.UPLOADING,
    );
  }

  async presignMultipartParts(
    sessionId: string,
    partNumbers: number[],
    actor?: FileActorContext,
  ): Promise<MultipartPartUrlItem[]> {
    if (
      !Array.isArray(partNumbers) ||
      partNumbers.length === 0 ||
      partNumbers.length > MAX_PART_PRESIGN_BATCH
    ) {
      throw new BadRequestException(
        `partNumbers must contain between 1 and ${MAX_PART_PRESIGN_BATCH} part numbers`,
      );
    }

    const session = await this.getValidActiveSession(sessionId, actor);
    const uniqueParts = Array.from(new Set(partNumbers));
    for (const partNumber of uniqueParts) {
      if (
        !Number.isInteger(partNumber) ||
        partNumber < 1 ||
        partNumber > session.totalParts
      ) {
        throw new BadRequestException(
          `Invalid part number ${partNumber}. Expected an integer between 1 and ${session.totalParts}`,
        );
      }
    }

    await this.ensureSessionUploading(session);
    return Promise.all(
      uniqueParts.map(async (partNumber) => ({
        partNumber,
        uploadUrl: await this.h.driver.getPresignedPartUploadUrl(
          session.s3Key,
          session.s3UploadId,
          partNumber,
          3600,
        ),
      })),
    );
  }

  private async replayCompletedSession(
    session: UploadSessionRecord,
    cleanFilename: string,
  ): Promise<CompleteFileMultipartOutput> {
    if (session.resultBlobId) {
      const blob = await this.h.blobRepo.findById(session.resultBlobId);
      if (blob && blob.status !== BlobStatus.DELETED) {
        return this.h.buildMultipartOutput(blob, session, cleanFilename, false);
      }
    }
    throw new BadRequestException(
      `Upload session has already been ${session.status}`,
    );
  }

  async completeMultipart(
    input: CompleteFileMultipartInput,
  ): Promise<CompleteFileMultipartOutput> {
    if (!Array.isArray(input.parts) || input.parts.length === 0) {
      throw new BadRequestException('Parts array cannot be empty');
    }

    const session = await this.h.sessionRepo.findById(input.sessionId);
    if (!session) {
      throw new NotFoundException('Upload session not found or expired');
    }
    this.verifySessionAccess(session, input.actor);
    const cleanFilename = this.h.validateSafeFilename(session.filename);

    if (session.status === UploadSessionStatus.COMPLETED) {
      return this.replayCompletedSession(session, cleanFilename);
    }
    if (
      session.status === UploadSessionStatus.ABORTED ||
      session.status === UploadSessionStatus.EXPIRED
    ) {
      throw new BadRequestException(
        `Upload session has already been ${session.status}`,
      );
    }
    if (Date.now() > session.expiresAt.getTime()) {
      throw new NotFoundException('Upload session not found or expired');
    }
    if (session.status === UploadSessionStatus.FINALIZING) {
      this.h.throwFinalizingConflict(
        'Upload session is currently finalizing. Please retry shortly.',
      );
    }

    const claimed = await this.h.sessionRepo.claimForFinalizing(session.id);
    if (!claimed) {
      const latest = await this.h.sessionRepo.findById(session.id);
      if (latest?.status === UploadSessionStatus.COMPLETED) {
        return this.replayCompletedSession(latest, cleanFilename);
      }
      if (latest?.status === UploadSessionStatus.FINALIZING) {
        this.h.throwFinalizingConflict(
          'Upload session is currently finalizing. Please retry shortly.',
        );
      }
      throw new BadRequestException(
        'Upload session cannot be completed in its current state',
      );
    }

    let completed = false;
    try {
      try {
        await this.h.driver.completeMultipartUpload(
          session.s3Key,
          session.s3UploadId,
          input.parts.map((p) => ({ partNumber: p.partNumber, eTag: p.eTag })),
        );
      } catch (assembleErr: unknown) {
        const alreadyAssembled = await this.h.driver
          .stat(session.s3Key)
          .then((s) => Boolean(s && s.size > 0))
          .catch(() => false);
        if (!alreadyAssembled) {
          throw assembleErr;
        }
        this.h.logger.warn(
          `completeMultipartUpload threw for session ${session.id}, but staging object ${session.s3Key} already exists; continuing stat verification.`,
        );
      }

      const stat = await this.h.driver.stat(session.s3Key);
      if (!stat || stat.size <= 0) {
        throw new NotFoundException(
          'Completed multipart object is empty or not found in storage backend',
        );
      }

      const actualSizeBytes = BigInt(stat.size);
      const actualMime =
        stat.mimeType && stat.mimeType !== 'application/octet-stream'
          ? stat.mimeType
          : session.mimeType;

      const registered = await this.h.finalizeStagingObject({
        storageKey: session.s3Key,
        spaceId: resolveTargetSpaceId(session.spaceId, session.userId),
        sizeBytes: actualSizeBytes,
        mimeType: actualMime,
        validationFilename: session.filename,
        contentHashHex: session.expectedHashHex ?? undefined,
        checksumVerified: false,
      });

      const completedSession = await this.h.sessionRepo.markCompletedWithBlob(
        session.id,
        registered.blob.id,
      );
      completed = true;

      if (registered.needsAsyncPromotion) {
        await this.h.enqueueCasPromotion({
          blobId: registered.blob.id,
          stagingKey: session.s3Key,
          declaredHashHex: session.expectedHashHex ?? undefined,
        });
      }

      return this.h.buildMultipartOutput(
        registered.blob,
        completedSession,
        cleanFilename,
        registered.isDeduplicated,
      );
    } catch (err) {
      if (!completed) {
        await this.h.sessionRepo
          .releaseFinalizingToUploading(session.id)
          .catch(() => {});
      }
      throw err;
    }
  }

  async abortMultipart(
    sessionId: string,
    actor?: FileActorContext,
  ): Promise<void> {
    const session = await this.h.sessionRepo.findById(sessionId);
    if (!session) throw new NotFoundException('Upload session not found');
    this.verifySessionAccess(session, actor);
    if (session.status === UploadSessionStatus.COMPLETED) {
      throw new BadRequestException(
        'Cannot abort an already completed upload session',
      );
    }
    if (session.status === UploadSessionStatus.FINALIZING) {
      this.h.throwFinalizingConflict(
        'Upload session is currently finalizing and cannot be aborted',
      );
    }
    if (session.status === UploadSessionStatus.ABORTED) return;

    await this.h.driver
      .abortMultipartUpload(session.s3Key, session.s3UploadId)
      .catch(() => {});
    await this.h.sessionRepo.markStatus(
      session.id,
      UploadSessionStatus.ABORTED,
    );
  }

  async cleanupExpiredSessions(limit = 50): Promise<number> {
    const expiredSessions = await this.h.sessionRepo.findExpiredSessions(
      new Date(),
      limit,
    );
    let abortedCount = 0;
    for (const session of expiredSessions) {
      try {
        await this.h.driver.abortMultipartUpload(
          session.s3Key,
          session.s3UploadId,
        );
        await this.h.sessionRepo.markStatus(
          session.id,
          UploadSessionStatus.ABORTED,
        );
        abortedCount++;
      } catch (err: unknown) {
        this.h.logger.warn(
          `Failed aborting expired session ${session.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return abortedCount;
  }

  async recoverStaleFinalizingSessions(limit = 50): Promise<number> {
    const staleBefore = new Date(
      Date.now() - STALE_FINALIZING_LEASE_MINUTES * 60_000,
    );
    const staleSessions = await this.h.sessionRepo.findStaleFinalizingSessions(
      staleBefore,
      limit,
    );
    let recoveredCount = 0;
    for (const session of staleSessions) {
      try {
        if (session.expiresAt.getTime() <= Date.now()) {
          await this.h.driver
            .abortMultipartUpload(session.s3Key, session.s3UploadId)
            .catch(() => {});
          await this.h.sessionRepo.markStatus(
            session.id,
            UploadSessionStatus.ABORTED,
          );
          recoveredCount++;
        } else {
          const released =
            await this.h.sessionRepo.releaseFinalizingToUploading(session.id);
          if (released) recoveredCount++;
        }
      } catch (err: unknown) {
        this.h.logger.warn(
          `Failed recovering stale FINALIZING session ${session.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return recoveredCount;
  }

  async sweepUnpromotedStagingBlobs(limit = 100): Promise<number> {
    if (!this.h.hasFinalizeQueue) return 0;
    const olderThan = new Date(
      Date.now() - STAGING_SWEEP_MIN_AGE_MINUTES * 60_000,
    );
    const blobs = await this.h.blobRepo.findUnpromotedStagingBlobs(
      olderThan,
      limit,
    );
    for (const blob of blobs) {
      await this.h.enqueueCasPromotion({
        blobId: blob.id,
        stagingKey: blob.s3Key,
        declaredHashHex: blob.checksumVerified
          ? blob.contentHashHex
          : undefined,
      });
    }
    return blobs.length;
  }
}
