import {
  Injectable,
  Inject,
  Logger,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  Optional,
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
  DEFAULT_STORAGE_QUOTA_BYTES,
} from '@/modules/storage/drive';
import {
  BlobService,
  StorageRedisCacheService,
  FileUploadedEvent,
  ContentHash,
  isBlockedExtension,
  validateMagicBytes,
  sanitizeFilename,
  streamToBuffer,
} from '@/modules/storage/core';
import { getFileContentPath } from '@/modules/storage/storage.port';
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
export class UploadService {
  private readonly logger = new Logger(UploadService.name);

  constructor(
    private readonly blobService: BlobService,
    @Inject(STORAGE_NODE_REPOSITORY)
    private readonly nodeRepo: IStorageNodeRepository,
    @Inject(STORAGE_QUOTA_REPOSITORY)
    private readonly quotaRepo: IStorageQuotaRepository,
    @Optional()
    private readonly cache?: StorageRedisCacheService,
    @Optional()
    private readonly eventEmitter?: EventEmitter2,
  ) {}

  private resolveScopeAndMetadata(input: {
    scope?: FileScope;
    linkedToType?: string;
    linkedToId?: string | null;
    projectId?: string | null;
    pageId?: string | null;
    source?: string;
    metaData?: Record<string, unknown> | null;
  }) {
    const resolvedScope =
      input.scope ??
      (input.linkedToType as FileScope | undefined) ??
      (input.pageId
        ? FileScope.Page
        : input.projectId
          ? FileScope.Project
          : FileScope.Personal);
    const resolvedLinkedId =
      input.linkedToId ?? input.pageId ?? input.projectId ?? null;
    const metadata: Record<string, unknown> = {
      ...(input.metaData || {}),
      ...(input.source ? { source: input.source } : {}),
      ...(input.pageId ? { pageId: input.pageId } : {}),
    };
    return { resolvedScope, resolvedLinkedId, metadata };
  }

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
    const { resolvedScope, resolvedLinkedId, metadata } =
      this.resolveScopeAndMetadata(input);
    const node = new StorageNode({
      id: fileId,
      projectId: input.projectId ?? null,
      linkedToId: resolvedLinkedId,
      parentId: input.parentId ?? null,
      name: cleanFilename,
      isFolder: false,
      size: sizeBytes,
      mimeType: input.mimeType,
      blobId,
      scope: resolvedScope,
      metadata,
      authorId: input.userId,
    });
    await this.nodeRepo.create(node);

    // 7. Invalidate folder listing cache
    if (this.cache) {
      await this.cache.invalidateFolder(scopeKey, input.parentId ?? null);
      await this.cache.invalidateScopeTree(scopeKey);
    }

    // 8. Emit domain event for async subscribers (AI indexing, virus scan)
    this.eventEmitter?.emit(
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
      url: getFileContentPath(fileId),
      filename: cleanFilename,
      size: Number(sizeBytes),
      mimeType: input.mimeType,
      isDeduplicated,
    };
  }

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
    const maxBytes = quota ? quota.maxBytes : DEFAULT_STORAGE_QUOTA_BYTES;
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
          // Charge quota BEFORE incrementing refCount so quota failure never leaks a refCount
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
          const { resolvedScope, resolvedLinkedId, metadata } =
            this.resolveScopeAndMetadata(input);
          const node = new StorageNode({
            id: fileId,
            projectId: input.projectId ?? null,
            linkedToId: resolvedLinkedId,
            parentId: input.parentId ?? null,
            name: cleanFilename,
            isFolder: false,
            size: existingBlob.sizeBytes,
            mimeType: input.mimeType,
            blobId: existingBlob.id,
            scope: resolvedScope,
            metadata,
            authorId: input.userId,
          });
          await this.nodeRepo.create(node);

          const scopeKey = input.projectId ?? input.userId;
          if (this.cache) {
            await this.cache.invalidateFolder(scopeKey, input.parentId ?? null);
            await this.cache.invalidateScopeTree(scopeKey);
          }

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
            uploadUrl: '',
            storageKey: existingBlob.s3Key.value(),
            fileUuid: existingBlob.id,
            expiresIn: 0,
            fileId,
            url: getFileContentPath(fileId),
            filename: cleanFilename,
            size: Number(existingBlob.sizeBytes),
            mimeType: input.mimeType,
          };
        }
      } catch (err: unknown) {
        if (err instanceof BadRequestException) {
          throw err;
        }
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

  async complete(input: CompletePresignInput): Promise<CompletePresignOutput> {
    if (!input.storageKey.startsWith(`uploads/${input.userId}/`)) {
      throw new ForbiddenException('Invalid storage key ownership');
    }

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

    // 1.1 Verify binary magic bytes to prevent MIME spoofing & executable upload bypass (SEC-003)
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
        this.blobService.delete(input.storageKey).catch((delErr: unknown) => {
          this.logger.warn(
            `Failed to clean up rejected malicious upload ${input.storageKey}: ${delErr instanceof Error ? delErr.message : String(delErr)}`,
          );
        });
        throw err;
      }
    }

    const scopeKey = input.projectId ?? input.userId;

    // 2. Check and consume Quota (with rollback on downstream failure)
    await this.quotaRepo.incrementUsage(
      input.userId,
      input.projectId ?? null,
      actualSize,
    );

    let blob;
    try {
      // 3. Register physical StorageBlob via Core BlobService (CAS deduplication + S3 cleanup)
      const registered = await this.blobService.registerUploadedObject({
        storageKey: input.storageKey,
        sizeBytes: actualSize,
        contentHashHex: input.contentHash,
      });
      blob = registered.blob;
    } catch (err: unknown) {
      await this.quotaRepo
        .decrementUsage(input.userId, input.projectId ?? null, actualSize)
        .catch(() => {});
      throw err;
    }
    const blobId = blob.id;

    // 4. Create logical StorageNode
    const fileId = crypto.randomUUID();
    const { resolvedScope, resolvedLinkedId, metadata } =
      this.resolveScopeAndMetadata(input);
    const node = new StorageNode({
      id: fileId,
      projectId: input.projectId ?? null,
      linkedToId: resolvedLinkedId,
      parentId: input.parentId ?? null,
      name: cleanFilename,
      isFolder: false,
      size: actualSize,
      mimeType: actualMime,
      blobId,
      scope: resolvedScope,
      metadata,
      authorId: input.userId,
    });
    await this.nodeRepo.create(node);

    // 5. Invalidate folder listing cache
    if (this.cache) {
      await this.cache.invalidateFolder(scopeKey, input.parentId ?? null);
      await this.cache.invalidateScopeTree(scopeKey);
    }

    // 6. Emit domain event using canonical blob.s3Key.value() (not the potentially deleted input.storageKey)
    this.eventEmitter?.emit(
      'file.uploaded',
      new FileUploadedEvent(
        fileId,
        blobId,
        input.userId,
        cleanFilename,
        actualMime,
        actualSize,
        blob.s3Key.value(),
        input.projectId,
      ),
    );

    return {
      fileId,
      blobId,
      url: getFileContentPath(fileId),
      filename: cleanFilename,
      size: Number(actualSize),
      mimeType: actualMime,
    };
  }
}
