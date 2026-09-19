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
  STORAGE_QUOTA_REPOSITORY,
  STORAGE_VERSION_REPOSITORY,
} from '../../../storage.tokens';
import { IStorageDriver } from '../../../domain/ports/storage-driver.port';
import { IStorageNodeRepository } from '../../../domain/ports/storage-node.repository.port';
import { IStorageBlobRepository } from '../../../domain/ports/storage-blob.repository.port';
import { IStorageQuotaRepository } from '../../../domain/ports/storage-quota.repository.port';
import { IStorageVersionRepository } from '../../../domain/ports/storage-version.repository.port';
import { StorageAccessPolicy } from '../../policies/storage-access.policy';
import { StorageRedisCacheService } from '../../../infrastructure/cache/storage-redis-cache.service';
import { ContentHash } from '../../../domain/value-objects/content-hash.vo';
import { StorageKey } from '../../../domain/value-objects/storage-key.vo';
import {
  StorageBlob,
  BlobStatus,
} from '../../../domain/entities/storage-blob.entity';
import { StorageVersion } from '../../../domain/entities/storage-version.entity';
import { FileUploadedEvent } from '../../../domain/events/file-uploaded.event';
import {
  validateMagicBytes,
  sanitizeFilename,
} from '../../../domain/value-objects/file-validator.util';

export interface UploadNewVersionInput {
  fileId: string;
  userId: string;
  buffer: Buffer;
  filename: string;
  mimeType: string;
  changeComment?: string;
}

export interface UploadNewVersionOutput {
  fileId: string;
  versionNumber: number;
  blobId: string;
  size: number;
  filename: string;
  changeComment: string | null;
  createdAt: Date;
  isDeduplicated: boolean;
}

@Injectable()
export class UploadNewVersionUseCase {
  constructor(
    @Inject(STORAGE_DRIVER) private readonly driver: IStorageDriver,
    @Inject(STORAGE_NODE_REPOSITORY)
    private readonly nodeRepo: IStorageNodeRepository,
    @Inject(STORAGE_BLOB_REPOSITORY)
    private readonly blobRepo: IStorageBlobRepository,
    @Inject(STORAGE_QUOTA_REPOSITORY)
    private readonly quotaRepo: IStorageQuotaRepository,
    @Inject(STORAGE_VERSION_REPOSITORY)
    private readonly versionRepo: IStorageVersionRepository,
    private readonly accessPolicy: StorageAccessPolicy,
    private readonly cache: StorageRedisCacheService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async execute(input: UploadNewVersionInput): Promise<UploadNewVersionOutput> {
    // 1. Verify access (must have write permission)
    const node = await this.accessPolicy.assertCanAccess(
      input.userId,
      input.fileId,
      'write',
    );

    if (node.isFolder) {
      throw new BadRequestException('Cannot create a version for a folder');
    }

    const sizeBytes = BigInt(input.buffer.length);
    if (sizeBytes <= 0n) {
      throw new BadRequestException('Cannot upload an empty file version');
    }

    const cleanFilename = sanitizeFilename(input.filename || node.name);
    validateMagicBytes(input.buffer, input.mimeType, cleanFilename);

    // 2. Content-Addressable Hashing (SHA-256)
    const contentHash = ContentHash.fromBuffer(input.buffer);
    const hashHex = contentHash.toHex();

    // 3. CAS Deduplication Check
    const existingBlob = await this.blobRepo.findByHash(contentHash);
    let blobId: string;
    let isDeduplicated = false;

    if (existingBlob && existingBlob.isReady()) {
      existingBlob.incrementRef();
      await this.blobRepo.update(existingBlob);
      blobId = existingBlob.id;
      isDeduplicated = true;
    } else {
      // New Blob: consume quota
      await this.quotaRepo.incrementUsage(
        input.userId,
        node.projectId,
        sizeBytes,
      );

      const s3Key = StorageKey.forBlob(hashHex);
      await this.driver.put(s3Key.value(), input.buffer, {
        mimeType: input.mimeType,
        size: input.buffer.length,
      });

      const newBlob = new StorageBlob({
        id: crypto.randomUUID(),
        contentHash,
        sizeBytes,
        s3Key,
        s3Bucket: process.env.R2_BUCKET_NAME || 'flux',
        status: BlobStatus.READY,
        refCount: 1,
      });
      await this.blobRepo.create(newBlob);
      blobId = newBlob.id;
    }

    // 4. Calculate Version Number & Backfill Version 1 if needed
    const latestVer = await this.versionRepo.getLatestVersionNumber(node.id);
    let nextVersionNumber = latestVer + 1;

    if (latestVer === 0 && node.blobId) {
      // First revision upload on a legacy file: backfill v1 with existing blob
      await this.versionRepo.create(
        new StorageVersion({
          id: crypto.randomUUID(),
          fileId: node.id,
          blobId: node.blobId,
          versionNumber: 1,
          changeComment: 'Initial version',
          createdById: node.authorId,
          createdAt: node.createdAt,
          sizeBytes: node.size,
          mimeType: node.mimeType,
        }),
      );
      nextVersionNumber = 2;
    }

    // 5. Create new FileVersion record
    const newVersion = await this.versionRepo.create(
      new StorageVersion({
        id: crypto.randomUUID(),
        fileId: node.id,
        blobId,
        versionNumber: nextVersionNumber,
        changeComment: input.changeComment ?? null,
        createdById: input.userId,
        createdAt: new Date(),
        sizeBytes,
        mimeType: input.mimeType,
      }),
    );

    // 6. Update StorageNode to point to new active Blob & metadata
    node.updateBlob(blobId, sizeBytes, input.mimeType);
    await this.nodeRepo.update(node);

    // 7. Invalidate cache
    const scopeKey = node.projectId ?? node.authorId;
    await this.cache.invalidateFolder(scopeKey, node.parentId);

    // 8. Emit domain event so AI RAG engine re-indexes the new revision
    this.eventEmitter.emit(
      'file.uploaded',
      new FileUploadedEvent(
        node.id,
        blobId,
        input.userId,
        node.name,
        input.mimeType,
        sizeBytes,
        StorageKey.forBlob(hashHex).value(),
        node.projectId,
      ),
    );

    return {
      fileId: node.id,
      versionNumber: newVersion.versionNumber,
      blobId,
      size: Number(sizeBytes),
      filename: node.name,
      changeComment: newVersion.changeComment,
      createdAt: newVersion.createdAt,
      isDeduplicated,
    };
  }
}
