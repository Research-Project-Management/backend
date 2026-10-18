import {
  Injectable,
  Inject,
  Logger,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as crypto from 'crypto';
import {
  STORAGE_NODE_REPOSITORY,
  STORAGE_QUOTA_REPOSITORY,
} from '@/modules/storage/storage.tokens';
import {
  IStorageNodeRepository,
  IStorageQuotaRepository,
  FileScope,
  StorageNode,
} from '@/modules/storage/drive';
import {
  BlobService,
  StorageRedisCacheService,
  FileUploadedEvent,
  ContentHash,
  isBlockedExtension,
  validateMagicBytes,
  sanitizeFilename,
} from '@/modules/storage/core';
import type {
  UploadDirectInput,
  UploadDirectOutput,
  PresignUploadInput,
  PresignUploadOutput,
  CompletePresignInput,
  CompletePresignOutput,
} from '../types';

export type {
  UploadDirectInput,
  UploadDirectOutput,
  PresignUploadInput,
  PresignUploadOutput,
  CompletePresignInput,
  CompletePresignOutput,
};

@Injectable()
export class DirectUploadService {
  constructor(
    private readonly blobService: BlobService,
    @Inject(STORAGE_NODE_REPOSITORY)
    private readonly nodeRepo: IStorageNodeRepository,
    @Inject(STORAGE_QUOTA_REPOSITORY)
    private readonly quotaRepo: IStorageQuotaRepository,
    private readonly cache: StorageRedisCacheService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async upload(input: UploadDirectInput): Promise<UploadDirectOutput> {
    const scopeKey = input.projectId ?? input.userId;
    const sizeBytes = BigInt(input.buffer.length);

    if (sizeBytes <= 0n) {
      throw new BadRequestException('Cannot upload an empty file');
    }

    const cleanFilename = sanitizeFilename(input.filename);
    validateMagicBytes(input.buffer, input.mimeType, cleanFilename);

    // 1-5. Delegate CAS Hashing, Deduplication, Quota & Physical Storage to Core BlobService
    const { blob, isDeduplicated } = await this.blobService.storeBuffer(
      input.buffer,
      input.mimeType,
      async (bytes) => {
        await this.quotaRepo.incrementUsage(
          input.userId,
          input.projectId ?? null,
          bytes,
        );
      },
    );
    const blobId = blob.id;

    // 6. Create logical StorageNode
    const fileId = crypto.randomUUID();
    const node = new StorageNode({
      id: fileId,
      projectId: input.projectId ?? null,
      parentId: input.parentId ?? null,
      name: cleanFilename,
      isFolder: false,
      size: sizeBytes,
      mimeType: input.mimeType,
      blobId,
      scope:
        input.scope ??
        (input.projectId ? FileScope.Project : FileScope.Personal),
      metadata: input.source ? { source: input.source } : {},
      authorId: input.userId,
    });
    await this.nodeRepo.create(node);

    // 7. Invalidate folder listing cache and quota
    await this.cache.invalidateFolder(scopeKey, input.parentId ?? null);
    await this.cache.invalidateScopeTree(scopeKey);
    await this.cache.invalidateQuota(input.userId, input.projectId ?? null);

    // 8. Emit domain event for async subscribers (AI indexing, virus scan)
    this.eventEmitter.emit(
      'file.uploaded',
      new FileUploadedEvent(
        fileId,
        blobId,
        input.userId,
        cleanFilename,
        input.mimeType,
        sizeBytes,
        blob.s3Key.value(),
        input.projectId,
      ),
    );

    return {
      fileId,
      blobId,
      url: `/api/v1/storage/files/${encodeURIComponent(fileId)}/content`,
      filename: cleanFilename,
      size: Number(sizeBytes),
      mimeType: input.mimeType,
      isDeduplicated,
    };
  }
}

@Injectable()
export class PresignService {
  private readonly logger = new Logger(PresignService.name);

  constructor(
    private readonly blobService: BlobService,
    @Inject(STORAGE_NODE_REPOSITORY)
    private readonly nodeRepo: IStorageNodeRepository,
    @Inject(STORAGE_QUOTA_REPOSITORY)
    private readonly quotaRepo: IStorageQuotaRepository,
  ) {}

  async presign(input: PresignUploadInput): Promise<PresignUploadOutput> {
    const cleanFilename = sanitizeFilename(input.filename);
    if (isBlockedExtension(cleanFilename)) {
      throw new BadRequestException(
        'File extension is prohibited for security reasons',
      );
    }

    // 0. Strict Quota Pre-check: Block upload URL generation if user/project quota exceeded
    const requestedBytes = BigInt(input.sizeBytes);
    const quota = await this.quotaRepo.findByScope(
      input.userId,
      input.projectId ?? null,
    );
    const DEFAULT_LIMIT = 5n * 1024n * 1024n * 1024n; // 5 GB
    const maxBytes = quota ? quota.maxBytes : DEFAULT_LIMIT;
    const usedBytes = quota ? quota.usedBytes : 0n;
    if (usedBytes + requestedBytes > maxBytes) {
      throw new BadRequestException('Storage quota exceeded');
    }

    // 1. Instant CAS Deduplication Check:
    // If client pre-computed SHA-256 and identical blob exists, create reference immediately (Zero-byte transfer)
    if (input.contentHash) {
      try {
        const hashVo = ContentHash.fromHex(input.contentHash);
        const existingBlob = await this.blobService.findBlobByHash(hashVo);

        if (existingBlob && existingBlob.isReady()) {
          await this.blobService.incrementBlobRef(existingBlob.id);

          await this.quotaRepo
            .incrementUsage(
              input.userId,
              input.projectId ?? null,
              existingBlob.sizeBytes,
            )
            .catch((err) => {
              this.logger.warn(
                `Failed to increment quota for CAS deduplicated file: ${err?.message || err}`,
              );
            });

          const fileId = crypto.randomUUID();
          const node = new StorageNode({
            id: fileId,
            projectId: input.projectId ?? null,
            parentId: input.parentId ?? null,
            name: cleanFilename,
            isFolder: false,
            size: existingBlob.sizeBytes,
            mimeType: input.mimeType,
            blobId: existingBlob.id,
            scope:
              input.scope ??
              (input.projectId ? FileScope.Project : FileScope.Personal),
            authorId: input.userId,
          });
          await this.nodeRepo.create(node);

          return {
            deduplicated: true,
            uploadUrl: '',
            storageKey: existingBlob.s3Key.value(),
            fileUuid: existingBlob.id,
            expiresIn: 0,
            fileId,
            url: `/api/v1/storage/files/${encodeURIComponent(fileId)}/content`,
            filename: cleanFilename,
            size: Number(existingBlob.sizeBytes),
            mimeType: input.mimeType,
          };
        }
      } catch (err: unknown) {
        this.logger.debug(
          `CAS pre-lookup skipped or failed for hash ${input.contentHash}: ${(err as Error)?.message}`,
        );
      }
    }

    const MAX_SINGLE_UPLOAD = 100 * 1024 * 1024; // 100MB
    if (input.sizeBytes > MAX_SINGLE_UPLOAD) {
      throw new BadRequestException(
        'Files larger than 100MB must use multipart upload',
      );
    }

    const fileUuid = crypto.randomUUID();
    const cleanExt = (cleanFilename.split('.').pop() || 'bin').replace(
      /[^a-zA-Z0-9]/g,
      '',
    );
    const storageKey = `uploads/${input.userId}/${fileUuid}.${cleanExt}`;

    const uploadUrl = await this.blobService.getPresignedUploadUrl(storageKey, {
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      expiresInSeconds: 300, // 5 minutes
    });

    return {
      deduplicated: false,
      uploadUrl,
      storageKey,
      fileUuid,
      expiresIn: 300,
    };
  }
}

@Injectable()
export class CompletePresignService {
  private readonly logger = new Logger(CompletePresignService.name);

  constructor(
    private readonly blobService: BlobService,
    @Inject(STORAGE_NODE_REPOSITORY)
    private readonly nodeRepo: IStorageNodeRepository,
    @Inject(STORAGE_QUOTA_REPOSITORY)
    private readonly quotaRepo: IStorageQuotaRepository,
    private readonly cache: StorageRedisCacheService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async complete(input: CompletePresignInput): Promise<CompletePresignOutput> {
    const cleanFilename = sanitizeFilename(input.filename);
    if (isBlockedExtension(cleanFilename)) {
      throw new BadRequestException(
        'File extension is prohibited for security reasons',
      );
    }

    // 1. Verify object existence in physical driver
    let actualSize = input.sizeBytes ? BigInt(input.sizeBytes) : 0n;
    let actualMime = input.mimeType || 'application/octet-stream';

    try {
      const stat = await this.blobService.stat(input.storageKey);
      if (stat && stat.size > 0) {
        actualSize = BigInt(stat.size);
        if (stat.mimeType && stat.mimeType !== 'application/octet-stream') {
          actualMime = stat.mimeType;
        }
      }
    } catch {
      // If stat fails, check if caller provided non-zero size
      if (actualSize <= 0n) {
        throw new NotFoundException(
          'Uploaded object not found or verified in storage backend',
        );
      }
    }

    // 1.1 Verify binary magic bytes to prevent MIME spoofing & executable upload bypass (SEC-003)
    try {
      const streamRes = await this.blobService.getStream(input.storageKey, {
        start: 0,
        end: 511,
      });
      if (streamRes && streamRes.stream) {
        const chunks: Buffer[] = [];
        for await (const chunk of streamRes.stream) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const headerBuffer = Buffer.concat(chunks);
        if (headerBuffer.length > 0) {
          validateMagicBytes(headerBuffer, actualMime, cleanFilename);
        }
      }
    } catch (err: unknown) {
      if (err instanceof BadRequestException) {
        // Immediate cleanup of malicious payload from physical storage
        this.blobService.delete(input.storageKey).catch((delErr) => {
          this.logger.warn(
            `Failed to clean up rejected malicious upload ${input.storageKey}: ${delErr?.message || delErr}`,
          );
        });
        throw err;
      }
    }

    const scopeKey = input.projectId ?? input.userId;

    // 2. Check and consume Quota
    await this.quotaRepo.incrementUsage(
      input.userId,
      input.projectId ?? null,
      actualSize,
    );

    // 3. Register physical StorageBlob via Core BlobService (CAS deduplication + S3 cleanup)
    const { blob } = await this.blobService.registerUploadedObject({
      storageKey: input.storageKey,
      sizeBytes: actualSize,
      contentHashHex: input.contentHash,
    });
    const blobId = blob.id;

    // 4. Create logical StorageNode
    const fileId = crypto.randomUUID();
    const node = new StorageNode({
      id: fileId,
      projectId: input.projectId ?? null,
      parentId: input.parentId ?? null,
      name: cleanFilename,
      isFolder: false,
      size: actualSize,
      mimeType: actualMime,
      blobId,
      scope:
        input.scope ??
        (input.projectId ? FileScope.Project : FileScope.Personal),
      authorId: input.userId,
    });
    await this.nodeRepo.create(node);

    // 5. Invalidate folder listing cache and quota
    await this.cache.invalidateFolder(scopeKey, input.parentId ?? null);
    await this.cache.invalidateScopeTree(scopeKey);
    await this.cache.invalidateQuota(input.userId, input.projectId ?? null);

    // 6. Emit domain event
    this.eventEmitter.emit(
      'file.uploaded',
      new FileUploadedEvent(
        fileId,
        blobId,
        input.userId,
        cleanFilename,
        actualMime,
        actualSize,
        input.storageKey,
        input.projectId,
      ),
    );

    return {
      fileId,
      blobId,
      url: `/api/v1/storage/files/${encodeURIComponent(fileId)}/content`,
      filename: cleanFilename,
      size: Number(actualSize),
      mimeType: actualMime,
    };
  }
}

