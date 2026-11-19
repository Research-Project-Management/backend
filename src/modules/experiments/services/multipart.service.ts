import {
  Injectable,
  Inject,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as crypto from 'crypto';
import {
  BlobService,
  ContentHash,
  isBlockedExtension,
  sanitizeFilename,
  StorageKey,
  STORAGE_QUOTA_REPOSITORY,
  streamToBuffer,
  UPLOAD_SESSION_REPOSITORY,
  UploadSession,
  UploadSessionStatus,
  validateMagicBytes,
  type IQuotaRepository,
  type ISessionRepository,
} from '@/modules/files';
import { EXPERIMENT_NODE_REPOSITORY } from '../experiments.constant';
import {
  CompleteMultipartInput,
  CompleteMultipartOutput,
  getFileContentPath,
  InitiateMultipartInput,
  MultipartActorContext,
} from '../experiments.type';
import { INodeRepository } from '../repositories/node.repository';
import { ExperimentNode } from '../domain/node.domain';
import { FileUploadedEvent } from '../domain/experiments.event';
import { ExperimentsCacheService } from './cache.service';

export type {
  MultipartActorContext,
  InitiateMultipartInput,
  CompleteMultipartInput,
  CompleteMultipartOutput,
};

@Injectable()
export class MultipartService {
  constructor(
    private readonly blobService: BlobService,
    @Inject(EXPERIMENT_NODE_REPOSITORY)
    private readonly nodeRepo: INodeRepository,
    @Inject(UPLOAD_SESSION_REPOSITORY)
    private readonly sessionRepo: ISessionRepository,
    @Inject(STORAGE_QUOTA_REPOSITORY)
    private readonly quotaRepo: IQuotaRepository,
    private readonly cache: ExperimentsCacheService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async initiate(input: InitiateMultipartInput) {
    const cleanFilename = sanitizeFilename(input.filename);
    if (isBlockedExtension(cleanFilename)) {
      throw new BadRequestException(
        'File extension is prohibited for security reasons',
      );
    }

    const totalSizeBytes = BigInt(input.totalSize);
    const quota = await this.quotaRepo.findByScope(
      input.userId,
      input.projectId ?? null,
    );
    const maxBytes = quota ? quota.maxBytes : 5n * 1024n * 1024n * 1024n;
    const usedBytes = quota ? quota.usedBytes : 0n;
    if (usedBytes + totalSizeBytes > maxBytes) {
      throw new BadRequestException('Storage quota exceeded');
    }

    if (input.expectedHash && /^[a-f0-9]{64}$/i.test(input.expectedHash)) {
      try {
        const hashVo = ContentHash.fromHex(input.expectedHash);
        const existingBlob = await this.blobService.findBlobByHash(hashVo);
        if (existingBlob && existingBlob.isReady()) {
          await this.quotaRepo.incrementUsage(
            input.userId,
            input.projectId ?? null,
            existingBlob.sizeBytes,
          );
          try {
            await this.blobService.incrementBlobRef(existingBlob.id);
          } catch (refErr) {
            await this.quotaRepo
              .decrementUsage(
                input.userId,
                input.projectId ?? null,
                existingBlob.sizeBytes,
              )
              .catch(() => {});
            throw refErr;
          }

          const fileId = crypto.randomUUID();
          const node = new ExperimentNode({
            id: fileId,
            projectId: input.projectId ?? null,
            parentId: input.parentId ?? null,
            name: cleanFilename,
            isFolder: false,
            size: existingBlob.sizeBytes,
            mimeType: input.mimeType,
            blobId: existingBlob.id,
            scope: input.scope,
            authorId: input.userId,
          });
          await this.nodeRepo.create(node);

          const scopeKey = input.projectId ?? input.userId;
          await this.cache?.invalidateFolder?.(
            scopeKey,
            input.parentId ?? null,
          );
          await this.cache?.invalidateScopeTree?.(scopeKey);

          this.eventEmitter?.emit(
            'file.uploaded',
            new FileUploadedEvent(
              fileId,
              existingBlob.id,
              input.userId,
              cleanFilename,
              input.mimeType,
              existingBlob.sizeBytes,
              existingBlob.s3Key.value(),
              input.projectId,
            ),
          );

          return {
            deduplicated: true,
            sessionId: '',
            uploadId: '',
            partSize: 0,
            totalParts: 0,
            fileId,
            url: getFileContentPath(fileId),
            filename: cleanFilename,
            size: Number(existingBlob.sizeBytes),
          };
        }
      } catch (err: unknown) {
        if (err instanceof BadRequestException) {
          throw err;
        }
      }
    }

    const MIN_PART_SIZE = 10 * 1024 * 1024;
    const MAX_PARTS = 8000;
    let partSize = MIN_PART_SIZE;
    if (input.totalSize / partSize > MAX_PARTS) {
      partSize = Math.ceil(input.totalSize / MAX_PARTS);
      partSize = Math.ceil(partSize / (1024 * 1024)) * 1024 * 1024;
    }
    const totalParts = Math.ceil(input.totalSize / partSize);

    const sessionId = crypto.randomUUID();
    const cleanExt = (cleanFilename.split('.').pop() || 'bin').replace(
      /[^a-zA-Z0-9]/g,
      '',
    );
    const s3Key = StorageKey.forMultipartStaging(sessionId, cleanExt).value();

    const { uploadId } = await this.blobService.initiateMultipartUpload(s3Key, {
      mimeType: input.mimeType,
    });

    const expectedHashBuffer =
      input.expectedHash && /^[a-f0-9]{64}$/i.test(input.expectedHash)
        ? Buffer.from(input.expectedHash.toLowerCase(), 'hex')
        : null;
    const session = new UploadSession({
      id: sessionId,
      projectId: input.projectId,
      userId: input.userId,
      s3UploadId: uploadId,
      s3Key,
      filename: cleanFilename,
      mimeType: input.mimeType,
      totalSize: totalSizeBytes,
      partSize,
      totalParts,
      parentId: input.parentId,
      scope: input.scope,
      expectedHash: expectedHashBuffer,
      expiresAt: new Date(Date.now() + 4 * 3600 * 1000),
    });
    await this.sessionRepo.create(session);

    return {
      sessionId,
      uploadId,
      partSize,
      totalParts,
    };
  }

  private verifySessionAccess(
    session: UploadSession,
    actor?: MultipartActorContext,
  ): void {
    if (!actor) return;
    if (session.userId === actor.userId) return;
    if (
      session.projectId &&
      actor.projectId &&
      session.projectId === actor.projectId
    ) {
      return;
    }
    throw new NotFoundException('Upload session not found');
  }

  private async getValidActiveSession(
    sessionId: string,
    actor?: MultipartActorContext,
  ): Promise<UploadSession> {
    const session = await this.sessionRepo.findById(sessionId);
    if (!session || session.isExpired()) {
      throw new NotFoundException('Upload session not found or expired');
    }

    this.verifySessionAccess(session, actor);

    if (session.status === UploadSessionStatus.COMPLETED) {
      throw new BadRequestException(
        'Upload session has already been completed',
      );
    }
    if (session.status === UploadSessionStatus.ABORTED) {
      throw new BadRequestException('Upload session has been aborted');
    }

    return session;
  }

  async getPartUrl(
    sessionId: string,
    partNumber: number,
    actor?: MultipartActorContext,
  ): Promise<string> {
    const session = await this.getValidActiveSession(sessionId, actor);

    if (
      !Number.isInteger(partNumber) ||
      partNumber < 1 ||
      partNumber > session.totalParts
    ) {
      throw new BadRequestException(
        `Invalid partNumber: must be an integer between 1 and ${session.totalParts}`,
      );
    }

    session.markUploading();
    await this.sessionRepo.update(session);

    return this.blobService.getPresignedPartUploadUrl(
      session.s3Key,
      session.s3UploadId,
      partNumber,
      3600,
    );
  }

  async complete(input: CompleteMultipartInput) {
    const session = await this.getValidActiveSession(
      input.sessionId,
      input.actor,
    );

    const cleanFilename = sanitizeFilename(session.filename);
    if (isBlockedExtension(cleanFilename)) {
      throw new BadRequestException(
        'File extension is prohibited for security reasons',
      );
    }

    if (
      !input.parts ||
      !Array.isArray(input.parts) ||
      input.parts.length === 0
    ) {
      throw new BadRequestException('Parts array cannot be empty');
    }

    const normalizedParts = input.parts.map((p) => ({
      partNumber: p.partNumber,
      eTag: p.eTag,
    }));

    await this.blobService.completeMultipartUpload(
      session.s3Key,
      session.s3UploadId,
      normalizedParts,
    );

    try {
      const streamRes = await this.blobService.getStream(session.s3Key, {
        start: 0,
        end: 511,
      });
      if (streamRes?.stream) {
        const headerBuffer = await streamToBuffer(streamRes.stream);
        if (headerBuffer.length > 0) {
          validateMagicBytes(headerBuffer, session.mimeType, cleanFilename);
        }
      }
    } catch (err: unknown) {
      if (err instanceof BadRequestException) {
        await this.blobService.delete(session.s3Key).catch(() => {});
        throw err;
      }
    }

    try {
      await this.quotaRepo.incrementUsage(
        session.userId,
        session.projectId,
        session.totalSize,
      );
    } catch (quotaErr) {
      Promise.resolve(this.blobService.delete(session.s3Key)).catch(() => {});
      throw quotaErr;
    }

    const partsSignature = normalizedParts
      .slice()
      .sort((a, b) => a.partNumber - b.partNumber)
      .map((p) => `${p.partNumber}:${p.eTag}`)
      .join(';');
    const sessionExpectedHex = session.expectedHash
      ? session.expectedHash.toString('hex').toLowerCase()
      : null;
    const contentHashHex =
      sessionExpectedHex && /^[a-f0-9]{64}$/i.test(sessionExpectedHex)
        ? sessionExpectedHex
        : crypto
            .createHash('sha256')
            .update(`${session.totalSize}:${partsSignature}`)
            .digest('hex');

    let blob;
    try {
      const registered = await this.blobService.registerUploadedObject({
        storageKey: session.s3Key,
        sizeBytes: session.totalSize,
        contentHashHex,
      });
      blob = registered.blob;
    } catch (regErr) {
      await this.quotaRepo
        .decrementUsage(session.userId, session.projectId, session.totalSize)
        .catch(() => {});
      throw regErr;
    }
    const blobId = blob.id;

    const fileId = crypto.randomUUID();
    const node = new ExperimentNode({
      id: fileId,
      projectId: session.projectId,
      parentId: session.parentId,
      name: cleanFilename,
      isFolder: false,
      size: session.totalSize,
      mimeType: session.mimeType,
      blobId,
      scope: session.scope,
      authorId: session.userId,
    });
    await this.nodeRepo.create(node);

    session.markCompleted();
    await this.sessionRepo.update(session);
    const scopeKey = session.projectId ?? session.userId;
    await this.cache.invalidateFolder(scopeKey, session.parentId);
    if (typeof this.cache.invalidateScopeTree === 'function') {
      await this.cache.invalidateScopeTree(scopeKey);
    }

    this.eventEmitter.emit(
      'file.uploaded',
      new FileUploadedEvent(
        fileId,
        blobId,
        session.userId,
        cleanFilename,
        session.mimeType,
        session.totalSize,
        blob.s3Key.value(),
        session.projectId,
      ),
    );

    return {
      fileId,
      blobId,
      url: getFileContentPath(fileId),
      filename: cleanFilename,
      size: Number(session.totalSize),
    };
  }

  async abort(sessionId: string, actor?: MultipartActorContext): Promise<void> {
    const session = await this.sessionRepo.findById(sessionId);
    if (!session) {
      throw new NotFoundException('Upload session not found');
    }

    this.verifySessionAccess(session, actor);

    if (session.status === UploadSessionStatus.COMPLETED) {
      throw new BadRequestException(
        'Cannot abort an already completed upload session',
      );
    }
    if (session.status === UploadSessionStatus.ABORTED) {
      return;
    }

    await this.blobService.abortMultipartUpload(
      session.s3Key,
      session.s3UploadId,
    );
    session.markAborted();
    await this.sessionRepo.update(session);
  }
}
