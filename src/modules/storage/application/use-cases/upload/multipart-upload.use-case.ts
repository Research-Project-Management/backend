import {
  Injectable,
  Inject,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as crypto from 'crypto';
import {
  STORAGE_DRIVER,
  STORAGE_NODE_REPOSITORY,
  STORAGE_BLOB_REPOSITORY,
  UPLOAD_SESSION_REPOSITORY,
  STORAGE_QUOTA_REPOSITORY,
} from '../../../storage.tokens';
import {
  IStorageDriver,
  CompletedPart,
} from '../../../domain/ports/storage-driver.port';
import { IStorageNodeRepository } from '../../../domain/ports/storage-node.repository.port';
import { IStorageBlobRepository } from '../../../domain/ports/storage-blob.repository.port';
import { IUploadSessionRepository } from '../../../domain/ports/upload-session.repository.port';
import { IStorageQuotaRepository } from '../../../domain/ports/storage-quota.repository.port';
import { UploadSession } from '../../../domain/entities/upload-session.entity';
import {
  StorageBlob,
  BlobStatus,
} from '../../../domain/entities/storage-blob.entity';
import { StorageNode } from '../../../domain/entities/storage-node.entity';
import { ContentHash } from '../../../domain/value-objects/content-hash.vo';
import { StorageKey } from '../../../domain/value-objects/storage-key.vo';
import { FileScope } from '../../../domain/value-objects/file-scope.vo';
import { FileUploadedEvent } from '../../../domain/events/file-uploaded.event';
import { StorageRedisCacheService } from '../../../infrastructure/cache/storage-redis-cache.service';

export interface InitiateMultipartInput {
  userId: string;
  filename: string;
  mimeType: string;
  totalSize: number;
  projectId?: string | null;
  parentId?: string | null;
  scope?: FileScope;
  expectedHash?: string;
}

export interface CompleteMultipartInput {
  sessionId: string;
  parts: CompletedPart[];
}

@Injectable()
export class MultipartUploadUseCase {
  constructor(
    @Inject(STORAGE_DRIVER) private readonly driver: IStorageDriver,
    @Inject(STORAGE_NODE_REPOSITORY)
    private readonly nodeRepo: IStorageNodeRepository,
    @Inject(STORAGE_BLOB_REPOSITORY)
    private readonly blobRepo: IStorageBlobRepository,
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
    const { uploadId } = await this.driver.initiateMultipartUpload(s3Key, {
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

  /**
   * Phase 2: Presign Part Upload URL
   */
  async getPartUrl(sessionId: string, partNumber: number): Promise<string> {
    const session = await this.sessionRepo.findById(sessionId);
    if (!session || session.isExpired()) {
      throw new NotFoundException('Upload session not found or expired');
    }

    session.markUploading();
    await this.sessionRepo.update(session);

    return this.driver.getPresignedPartUploadUrl(
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
    if (!session) {
      throw new NotFoundException('Upload session not found');
    }

    // 1. Tell S3 to concatenate all uploaded parts
    await this.driver.completeMultipartUpload(
      session.s3Key,
      session.s3UploadId,
      input.parts,
    );

    // 2. Consume quota
    await this.quotaRepo.incrementUsage(
      session.userId,
      session.projectId,
      session.totalSize,
    );

    // 3. Create StorageBlob & StorageNode with deterministic parts-based ContentHash
    const blobId = crypto.randomUUID();
    const partsSignature = input.parts
      .slice()
      .sort((a, b) => a.partNumber - b.partNumber)
      .map((p) => `${p.partNumber}:${p.etag}`)
      .join(';');
    const contentHash = ContentHash.fromHex(
      crypto
        .createHash('sha256')
        .update(`${session.totalSize}:${partsSignature}`)
        .digest('hex'),
    );

    const blob = new StorageBlob({
      id: blobId,
      contentHash,
      sizeBytes: session.totalSize,
      s3Key: StorageKey.fromString(session.s3Key),
      s3Bucket: process.env.R2_BUCKET_NAME || 'flux',
      status: BlobStatus.READY,
      refCount: 1,
    });
    await this.blobRepo.create(blob);

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
      url: `/api/files/${encodeURIComponent(fileId)}/content`,
      filename: session.filename,
      size: Number(session.totalSize),
    };
  }

  async abort(sessionId: string): Promise<void> {
    const session = await this.sessionRepo.findById(sessionId);
    if (session) {
      await this.driver.abortMultipartUpload(session.s3Key, session.s3UploadId);
      session.markAborted();
      await this.sessionRepo.update(session);
    }
  }
}
