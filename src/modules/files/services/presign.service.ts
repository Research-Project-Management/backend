import {
  Injectable,
  Inject,
  Logger,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import * as crypto from 'crypto';
import * as path from 'path';
import {
  DEFAULT_MULTIPART_TTL_HOURS,
  DEFAULT_STAGING_TTL_SECONDS,
  MAX_MULTIPART_PARTS,
  MIN_MULTIPART_PART_SIZE_BYTES,
  UPLOAD_SESSION_REPOSITORY,
} from '../files.constant';
import { ContentHash, StorageKey } from '../domain/blob.domain';
import { UploadSession, UploadSessionStatus } from '../domain/session.domain';
import {
  isBlockedExtension,
  sanitizeFilename,
  streamToBuffer,
  validateMagicBytes,
} from '../domain/files.policy';
import { ISessionRepository } from '../repositories/session.repository';
import {
  CompleteFileMultipartInput,
  CompleteFileMultipartOutput,
  CompletePresignedFileInput,
  CompletePresignedFileOutput,
  FileActorContext,
  getFileContentPath,
  InitiateFileMultipartInput,
  InitiateFileMultipartOutput,
  PresignFileUploadInput,
  PresignFileUploadOutput,
} from '../types/files.type';
import { BlobService } from './blob.service';
import { QuotaService } from './quota.service';

@Injectable()
export class PresignService {
  private readonly logger = new Logger(PresignService.name);

  constructor(
    private readonly blobService: BlobService,
    private readonly quotaService: QuotaService,
    @Inject(UPLOAD_SESSION_REPOSITORY)
    private readonly sessionRepo: ISessionRepository,
  ) {}

  async presignUpload(
    input: PresignFileUploadInput,
  ): Promise<PresignFileUploadOutput> {
    const cleanFilename = sanitizeFilename(input.filename);
    if (isBlockedExtension(cleanFilename)) {
      throw new BadRequestException(
        'File extension is prohibited for security reasons',
      );
    }

    await this.quotaService.assertAvailable(
      input.userId,
      input.projectId ?? null,
      BigInt(input.sizeBytes),
    );

    if (input.contentHash && /^[a-f0-9]{64}$/i.test(input.contentHash)) {
      const hashVo = ContentHash.fromHex(input.contentHash);
      const existingBlob = await this.blobService.findBlobByHash(hashVo);
      if (existingBlob && existingBlob.isReady()) {
        await this.quotaService.reserve(
          input.userId,
          input.projectId ?? null,
          existingBlob.sizeBytes,
        );
        try {
          await this.blobService.incrementBlobRef(existingBlob.id);
        } catch (err) {
          await this.quotaService
            .release(
              input.userId,
              input.projectId ?? null,
              existingBlob.sizeBytes,
            )
            .catch(() => {});
          throw err;
        }
        return {
          deduplicated: true,
          blob: existingBlob,
          storageKey: existingBlob.s3Key.value(),
          cleanFilename,
          expiresIn: 0,
        };
      }
    }

    const fileUuid = crypto.randomUUID();
    const ext = path.extname(cleanFilename).replace(/^\./, '') || 'bin';
    const storageKey = StorageKey.forStaging(
      input.userId,
      fileUuid,
      ext,
    ).value();

    const uploadUrl = await this.blobService.getPresignedUploadUrl(storageKey, {
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      expiresInSeconds: DEFAULT_STAGING_TTL_SECONDS,
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

    const cleanFilename = sanitizeFilename(input.filename);
    if (isBlockedExtension(cleanFilename)) {
      throw new BadRequestException(
        'File extension is prohibited for security reasons',
      );
    }

    let actualSize = input.sizeBytes ? BigInt(input.sizeBytes) : 0n;
    let actualMime = input.mimeType || 'application/octet-stream';

    try {
      const stat = await this.blobService.stat(input.storageKey);
      if (stat && stat.size > 0) {
        actualSize = BigInt(stat.size);
        if (stat.mimeType && stat.mimeType !== 'application/octet-stream') {
          actualMime = stat.mimeType;
        }
      } else if (actualSize <= 0n) {
        throw new NotFoundException(
          'Uploaded object is empty or not found in storage backend',
        );
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
      if (actualSize <= 0n) {
        throw new NotFoundException(
          'Uploaded object not found or verified in storage backend',
        );
      }
    }

    try {
      const streamRes = await this.blobService.getStream(input.storageKey, {
        start: 0,
        end: 511,
      });
      if (streamRes?.stream) {
        const headerBuffer = await streamToBuffer(streamRes.stream);
        if (headerBuffer.length > 0) {
          validateMagicBytes(headerBuffer, actualMime, cleanFilename);
        }
      }
    } catch (err: unknown) {
      if (err instanceof BadRequestException) {
        Promise.resolve(this.blobService.delete(input.storageKey)).catch(
          () => {},
        );
        throw err;
      }
    }

    try {
      await this.quotaService.reserve(
        input.userId,
        input.projectId ?? null,
        actualSize,
      );
    } catch (quotaErr) {
      Promise.resolve(this.blobService.delete(input.storageKey)).catch(
        (delErr: unknown) => {
          this.logger.warn(
            `Failed to clean up staging object ${input.storageKey}: ${delErr instanceof Error ? delErr.message : String(delErr)}`,
          );
        },
      );
      throw quotaErr;
    }

    let registered: {
      blob: CompletePresignedFileOutput['blob'];
      isDeduplicated: boolean;
    };
    try {
      registered = await this.blobService.registerUploadedObject({
        storageKey: input.storageKey,
        sizeBytes: actualSize,
        contentHashHex: input.contentHash,
      });
    } catch (err) {
      await this.quotaService
        .release(input.userId, input.projectId ?? null, actualSize)
        .catch(() => {});
      throw err;
    }

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
    const cleanFilename = sanitizeFilename(input.filename);
    if (isBlockedExtension(cleanFilename)) {
      throw new BadRequestException(
        'File extension is prohibited for security reasons',
      );
    }

    const totalSizeBytes = BigInt(input.totalSize);
    await this.quotaService.assertAvailable(
      input.userId,
      input.projectId ?? null,
      totalSizeBytes,
    );

    if (input.expectedHash && /^[a-f0-9]{64}$/i.test(input.expectedHash)) {
      try {
        const hashVo = ContentHash.fromHex(input.expectedHash);
        const existingBlob = await this.blobService.findBlobByHash(hashVo);
        if (existingBlob && existingBlob.isReady()) {
          await this.quotaService.reserve(
            input.userId,
            input.projectId ?? null,
            existingBlob.sizeBytes,
          );
          try {
            await this.blobService.incrementBlobRef(existingBlob.id);
          } catch (refErr) {
            await this.quotaService
              .release(
                input.userId,
                input.projectId ?? null,
                existingBlob.sizeBytes,
              )
              .catch(() => {});
            throw refErr;
          }

          return {
            deduplicated: true,
            blob: existingBlob,
            sessionId: '',
            uploadId: '',
            storageKey: existingBlob.s3Key.value(),
            partSize: 0,
            totalParts: 0,
            cleanFilename,
          };
        }
      } catch (err: unknown) {
        if (err instanceof BadRequestException) {
          throw err;
        }
        this.logger.debug(
          `Multipart instant CAS lookup fell back to normal upload: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const minSizeFor8000 = Math.ceil(input.totalSize / MAX_MULTIPART_PARTS);
    const partSize = Math.max(MIN_MULTIPART_PART_SIZE_BYTES, minSizeFor8000);
    const totalParts = Math.max(1, Math.ceil(input.totalSize / partSize));

    const sessionId = crypto.randomUUID();
    const ext = path.extname(cleanFilename).replace(/^\./, '') || 'bin';
    const storageKey = StorageKey.forMultipartStaging(sessionId, ext).value();

    const { uploadId } = await this.blobService.initiateMultipartUpload(
      storageKey,
      { mimeType: input.mimeType },
    );

    const session = new UploadSession({
      id: sessionId,
      projectId: input.projectId ?? null,
      userId: input.userId,
      s3UploadId: uploadId,
      s3Key: storageKey,
      filename: cleanFilename,
      mimeType: input.mimeType,
      totalSize: totalSizeBytes,
      partSize,
      totalParts,
      expectedHash: input.expectedHash
        ? Buffer.from(input.expectedHash, 'hex')
        : null,
      parentId: input.parentId ?? null,
      scope: input.scope ?? (input.projectId ? 'Project' : 'Personal'),
      expiresAt: new Date(
        Date.now() + DEFAULT_MULTIPART_TTL_HOURS * 3600 * 1000,
      ),
    });

    await this.sessionRepo.create(session);

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

  async presignMultipartPart(
    sessionId: string,
    partNumber: number,
    actor?: FileActorContext,
  ): Promise<{ url: string; partNumber: number }> {
    const session = await this.sessionRepo.findById(sessionId);
    if (!session) {
      throw new NotFoundException('Upload session not found');
    }
    if (actor && session.userId !== actor.userId) {
      throw new ForbiddenException(
        'You do not have permission to sign parts for this upload session',
      );
    }
    if (
      session.status === UploadSessionStatus.ABORTED ||
      session.status === UploadSessionStatus.COMPLETED
    ) {
      throw new BadRequestException(
        `Cannot upload part: Session is ${session.status}`,
      );
    }
    if (session.isExpired()) {
      throw new BadRequestException('Upload session has expired');
    }
    if (partNumber < 1 || partNumber > session.totalParts) {
      throw new BadRequestException(
        `Invalid part number ${partNumber}. Expected 1..${session.totalParts}`,
      );
    }

    session.markUploading();
    await this.sessionRepo.update(session);

    const url = await this.blobService.getPresignedPartUploadUrl(
      session.s3Key,
      session.s3UploadId,
      partNumber,
      3600,
    );

    return { url, partNumber };
  }

  async completeMultipart(
    input: CompleteFileMultipartInput,
  ): Promise<CompleteFileMultipartOutput> {
    const session = await this.sessionRepo.findById(input.sessionId);
    if (!session) {
      throw new NotFoundException('Upload session not found');
    }
    if (input.actor && session.userId !== input.actor.userId) {
      throw new ForbiddenException(
        'You do not have permission to complete this upload session',
      );
    }
    if (
      session.status === UploadSessionStatus.ABORTED ||
      session.status === UploadSessionStatus.COMPLETED
    ) {
      throw new BadRequestException(
        `Upload session already ${session.status}`,
      );
    }

    await this.blobService.completeMultipartUpload(
      session.s3Key,
      session.s3UploadId,
      input.parts,
    );

    try {
      const streamRes = await this.blobService.getStream(session.s3Key, {
        start: 0,
        end: 511,
      });
      if (streamRes?.stream) {
        const headerBuffer = await streamToBuffer(streamRes.stream);
        if (headerBuffer.length > 0) {
          validateMagicBytes(headerBuffer, session.mimeType, session.filename);
        }
      }
    } catch (err: unknown) {
      if (err instanceof BadRequestException) {
        Promise.resolve(this.blobService.delete(session.s3Key)).catch(() => {});
        throw err;
      }
    }

    try {
      await this.quotaService.reserve(
        session.userId,
        session.projectId,
        session.totalSize,
      );
    } catch (quotaErr) {
      Promise.resolve(this.blobService.delete(session.s3Key)).catch(() => {});
      throw quotaErr;
    }

    const expectedHashHex = session.expectedHash
      ? session.expectedHash.toString('hex')
      : undefined;

    let registered: {
      blob: CompleteFileMultipartOutput['blob'];
      isDeduplicated: boolean;
    };
    try {
      registered = await this.blobService.registerUploadedObject({
        storageKey: session.s3Key,
        sizeBytes: session.totalSize,
        contentHashHex: expectedHashHex,
      });
    } catch (err) {
      await this.quotaService
        .release(session.userId, session.projectId, session.totalSize)
        .catch(() => {});
      throw err;
    }

    session.markCompleted();
    await this.sessionRepo.update(session);

    return {
      blob: registered.blob,
      session,
      isDeduplicated: registered.isDeduplicated,
    };
  }

  async abortMultipart(
    sessionId: string,
    actor?: FileActorContext,
  ): Promise<void> {
    const session = await this.sessionRepo.findById(sessionId);
    if (!session) return;

    if (actor && session.userId !== actor.userId) {
      throw new ForbiddenException(
        'You do not have permission to abort this upload session',
      );
    }

    if (session.status !== UploadSessionStatus.COMPLETED) {
      await this.blobService
        .abortMultipartUpload(session.s3Key, session.s3UploadId)
        .catch(() => {});
      session.markAborted();
      await this.sessionRepo.update(session);
    }
  }

  async cleanupExpiredSessions(limit = 50): Promise<number> {
    const expiredSessions = await this.sessionRepo.findExpiredSessions(
      new Date(),
      limit,
    );

    let abortedCount = 0;
    for (const session of expiredSessions) {
      try {
        await this.blobService.abortMultipartUpload(
          session.s3Key,
          session.s3UploadId,
        );
        session.markAborted();
        await this.sessionRepo.update(session);
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
