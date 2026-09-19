import {
  Injectable,
  Inject,
  Optional,
  BadRequestException,
} from '@nestjs/common';
import * as crypto from 'crypto';
import {
  STORAGE_DRIVER,
  STORAGE_BLOB_REPOSITORY,
  STORAGE_NODE_REPOSITORY,
  STORAGE_QUOTA_REPOSITORY,
} from '../../../storage.tokens';
import { IStorageDriver } from '../../../domain/ports/storage-driver.port';
import { IStorageBlobRepository } from '../../../domain/ports/storage-blob.repository.port';
import { IStorageNodeRepository } from '../../../domain/ports/storage-node.repository.port';
import { IStorageQuotaRepository } from '../../../domain/ports/storage-quota.repository.port';
import { ContentHash } from '../../../domain/value-objects/content-hash.vo';
import { StorageNode } from '../../../domain/entities/storage-node.entity';
import { FileScope } from '../../../domain/value-objects/file-scope.vo';
import {
  isBlockedExtension,
  sanitizeFilename,
} from '../../../domain/value-objects/file-validator.util';

export interface PresignUploadInput {
  userId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  contentHash?: string;
  projectId?: string | null;
  parentId?: string | null;
  scope?: FileScope;
}

export interface PresignUploadOutput {
  uploadUrl: string;
  storageKey: string;
  fileUuid: string;
  expiresIn: number;
  deduplicated: boolean;
  fileId?: string;
  url?: string;
  filename?: string;
  size?: number;
  mimeType?: string;
}

@Injectable()
export class PresignUploadUseCase {
  constructor(
    @Inject(STORAGE_DRIVER) private readonly driver: IStorageDriver,
    @Optional()
    @Inject(STORAGE_BLOB_REPOSITORY)
    private readonly blobRepo?: IStorageBlobRepository,
    @Optional()
    @Inject(STORAGE_NODE_REPOSITORY)
    private readonly nodeRepo?: IStorageNodeRepository,
    @Optional()
    @Inject(STORAGE_QUOTA_REPOSITORY)
    private readonly quotaRepo?: IStorageQuotaRepository,
  ) {}

  async execute(input: PresignUploadInput): Promise<PresignUploadOutput> {
    const cleanFilename = sanitizeFilename(input.filename);
    if (isBlockedExtension(cleanFilename)) {
      throw new BadRequestException(
        'File extension is prohibited for security reasons',
      );
    }

    // 1. Instant CAS Deduplication Check:
    // If client pre-computed SHA-256 and identical blob exists, create reference immediately (Zero-byte transfer)
    if (input.contentHash && this.blobRepo && this.nodeRepo) {
      try {
        const hashVo = ContentHash.fromHex(input.contentHash);
        const existingBlob = await this.blobRepo.findByHash(hashVo);

        if (existingBlob && existingBlob.isReady()) {
          existingBlob.incrementRef();
          await this.blobRepo.update(existingBlob);

          if (this.quotaRepo) {
            await this.quotaRepo
              .incrementUsage(
                input.userId,
                input.projectId ?? null,
                existingBlob.sizeBytes,
              )
              .catch(() => {});
          }

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
            url: `/api/files/${encodeURIComponent(fileId)}/content`,
            filename: cleanFilename,
            size: Number(existingBlob.sizeBytes),
            mimeType: input.mimeType,
          };
        }
      } catch {
        // Hash parse error or lookup error, proceed with normal upload
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

    const uploadUrl = await this.driver.getPresignedUploadUrl(storageKey, {
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
