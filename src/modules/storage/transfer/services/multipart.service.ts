import {
  Injectable,
  Inject,
  Optional,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as crypto from 'crypto';
import {
  STORAGE_NODE_REPOSITORY,
  UPLOAD_SESSION_REPOSITORY,
  STORAGE_QUOTA_REPOSITORY,
} from '@/modules/storage/storage.tokens';
import {
  BlobService,
  CompletedPart,
} from '@/modules/storage/core';
import {
  IStorageNodeRepository,
  IStorageQuotaRepository,
  StorageNode,
} from '@/modules/storage/drive';
import type { IUploadSessionRepository } from '../repositories/prisma-session.repository';
import {
  UploadSession,
  UploadSessionStatus,
  MultipartActorContext,
  InitiateMultipartInput,
  CompleteMultipartInput,
  CompleteMultipartOutput,
} from '../types';
import {
  FileUploadedEvent,
  StorageRedisCacheService,
} from '@/modules/storage/core';

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
    @Inject(STORAGE_NODE_REPOSITORY)
    private readonly nodeRepo: IStorageNodeRepository,
    @Inject(UPLOAD_SESSION_REPOSITORY)
    private readonly sessionRepo: IUploadSessionRepository,
    @Inject(STORAGE_QUOTA_REPOSITORY)
    private readonly quotaRepo: IStorageQuotaRepository,
    private readonly cache: StorageRedisCacheService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Phase 1: Initiate S3 Multipart Upload session
   * Calculates dynamic part sizes to guarantee parts count < 8000.
   */
  async initiate(input: InitiateMultipartInput) {
    const totalSizeBytes = BigInt(input.totalSize);

    // Strict Quota Pre-check: Reject if remaining quota is insufficient before initiating S3 multipart session
    const quota = await this.quotaRepo.findByScope(
      input.userId,
      input.projectId ?? null,
    );
    const DEFAULT_LIMIT = 5n * 1024n * 1024n * 1024n; // 5 GB
    const maxBytes = quota ? quota.maxBytes : DEFAULT_LIMIT;
    const usedBytes = quota ? quota.usedBytes : 0n;
    if (usedBytes + totalSizeBytes > maxBytes) {
      throw new BadRequestException('Storage quota exceeded');
    }

    // Dynamic chunk sizing formula: 10MB base, scaled up for multi-GB files
    const MIN_PART_SIZE = 10 * 1024 * 1024; // 10MB
    const MAX_PARTS = 8000;
    let partSize = MIN_PART_SIZE;
    if (input.totalSize / partSize > MAX_PARTS) {
      partSize = Math.ceil(input.totalSize / MAX_PARTS);
      partSize = Math.ceil(partSize / (1024 * 1024)) * 1024 * 1024; // Round up to MiB
    }
    const totalParts = Math.ceil(input.totalSize / partSize);

    const sessionId = crypto.randomUUID();
    const cleanExt = (input.filename.split('.').pop() || 'bin').replace(
      /[^a-zA-Z0-9]/g,
      '',
    );
    const s3Key = `uploads/multipart/${sessionId}/payload.${cleanExt}`;

    // Initiate multipart upload in S3/R2
    const { uploadId } = await this.blobService.initiateMultipartUpload(s3Key, {
      mimeType: input.mimeType,
    });

    // Persist UploadSession
    const session = new UploadSession({
      id: sessionId,
      projectId: input.projectId,
      userId: input.userId,
      s3UploadId: uploadId,
      s3Key,
      filename: input.filename,
      mimeType: input.mimeType,
      totalSize: totalSizeBytes,
      partSize,
      totalParts,
      parentId: input.parentId,
      scope: input.scope,
      expiresAt: new Date(Date.now() + 4 * 3600 * 1000), // 4 hours TTL
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
    // Return 404 to avoid leaking existence of upload session across users/projects (anti-BOLA)
    throw new NotFoundException('Upload session not found');
  }

  /**
   * Phase 2: Presign Part Upload URL
   */
  async getPartUrl(
    sessionId: string,
    partNumber: number,
    actor?: MultipartActorContext,
  ): Promise<string> {
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

  /**
   * Phase 3: Complete Multipart Upload and assemble object
   */
  async complete(input: CompleteMultipartInput) {
    const session = await this.sessionRepo.findById(input.sessionId);
    if (!session || session.isExpired()) {
      throw new NotFoundException('Upload session not found or expired');
    }

    this.verifySessionAccess(session, input.actor);

    if (session.status === UploadSessionStatus.COMPLETED) {
      throw new BadRequestException(
        'Upload session has already been completed',
      );
    }
    if (session.status === UploadSessionStatus.ABORTED) {
      throw new BadRequestException('Upload session has been aborted');
    }

    if (
      !input.parts ||
      !Array.isArray(input.parts) ||
      input.parts.length === 0
    ) {
      throw new BadRequestException('Parts array cannot be empty');
    }

    // 1. Tell S3 to concatenate all uploaded parts
    const normalizedParts = input.parts.map((p) => ({
      partNumber: p.partNumber,
      eTag: p.eTag || p.etag || '',
      etag: p.etag || p.eTag || '',
    }));

    await this.blobService.completeMultipartUpload(
      session.s3Key,
      session.s3UploadId,
      normalizedParts,
    );

    // 2. Consume quota
    await this.quotaRepo.incrementUsage(
      session.userId,
      session.projectId,
      session.totalSize,
    );

    // 3. Register StorageBlob via Core BlobService (CAS deduplication) & create StorageNode
    const partsSignature = normalizedParts
      .slice()
      .sort((a, b) => a.partNumber - b.partNumber)
      .map((p) => `${p.partNumber}:${p.eTag}`)
      .join(';');
    const contentHashHex = crypto
      .createHash('sha256')
      .update(`${session.totalSize}:${partsSignature}`)
      .digest('hex');

    const { blob } = await this.blobService.registerUploadedObject({
      storageKey: session.s3Key,
      sizeBytes: session.totalSize,
      contentHashHex,
    });
    const blobId = blob.id;

    const fileId = crypto.randomUUID();
    const node = new StorageNode({
      id: fileId,
      projectId: session.projectId,
      parentId: session.parentId,
      name: session.filename,
      isFolder: false,
      size: session.totalSize,
      mimeType: session.mimeType,
      blobId,
      scope: session.scope,
      authorId: session.userId,
    });
    await this.nodeRepo.create(node);

    // 4. Mark session complete & invalidate cache
    session.markCompleted();
    await this.sessionRepo.update(session);
    const scopeKey = session.projectId ?? session.userId;
    await this.cache.invalidateFolder(scopeKey, session.parentId);

    // 5. Emit domain event for async subscribers (AI indexing, virus scan)
    this.eventEmitter.emit(
      'file.uploaded',
      new FileUploadedEvent(
        fileId,
        blobId,
        session.userId,
        session.filename,
        session.mimeType,
        session.totalSize,
        session.s3Key,
        session.projectId,
      ),
    );

    return {
      fileId,
      blobId,
      url: `/api/v1/storage/files/${encodeURIComponent(fileId)}/content`,
      filename: session.filename,
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

    await this.blobService.abortMultipartUpload(session.s3Key, session.s3UploadId);
    session.markAborted();
    await this.sessionRepo.update(session);
  }
}
