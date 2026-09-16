import { Injectable, Inject, Optional, NotFoundException } from '@nestjs/common';
import * as crypto from 'crypto';
import {
  IStoragePort,
  ReadOwnedFileInput,
  ReadOwnedFileOutput,
  LinkFileInput,
  UploadFileInput,
  UploadFileOutput,
  getFileContentPath,
} from './storage.port';
import {
  STORAGE_DRIVER,
  STORAGE_NODE_REPOSITORY,
  STORAGE_BLOB_REPOSITORY,
} from './storage.tokens';
import { IStorageDriver } from './domain/ports/storage-driver.port';
import { IStorageNodeRepository } from './domain/ports/storage-node.repository.port';
import { IStorageBlobRepository } from './domain/ports/storage-blob.repository.port';
import { UploadDirectUseCase } from './application/use-cases/upload/upload-direct.use-case';
import { PresignUploadUseCase } from './application/use-cases/upload/presign-upload.use-case';
import { CheckQuotaUseCase } from './application/use-cases/quota/check-quota.use-case';
import { FileScope } from './domain/value-objects/file-scope.vo';

/**
 * StorageFacade: The Single Public Reception Desk for Storage
 * Implements IStoragePort for complete platform-wide storage services:
 * CAS deduplication, quota checking, streaming, presigned URLs, and entity attachments.
 */
@Injectable()
export class StorageFacade implements IStoragePort {
  constructor(
    @Inject(STORAGE_DRIVER) private readonly driver: IStorageDriver,
    @Inject(STORAGE_NODE_REPOSITORY)
    private readonly nodeRepo: IStorageNodeRepository,
    @Inject(STORAGE_BLOB_REPOSITORY)
    private readonly blobRepo: IStorageBlobRepository,
    private readonly uploadDirectUseCase: UploadDirectUseCase,
    @Optional()
    private readonly presignUploadUseCase?: PresignUploadUseCase,
    @Optional()
    private readonly checkQuotaUseCase?: CheckQuotaUseCase,
  ) {}

  async readOwnedFile(input: ReadOwnedFileInput): Promise<ReadOwnedFileOutput> {
    const node = await this.nodeRepo.findById(input.fileId);
    if (!node || node.isTrashed()) {
      throw new NotFoundException(`Storage node not found: ${input.fileId}`);
    }

    if (!node.blobId) {
      throw new NotFoundException(
        `File has no physical binary payload: ${input.fileId}`,
      );
    }

    const blob = await this.blobRepo.findById(node.blobId);
    if (!blob) {
      throw new NotFoundException(
        `Physical storage blob not found for node: ${input.fileId}`,
      );
    }

    const { stream } = await this.driver.getStream(blob.s3Key.value());
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const buffer = Buffer.concat(chunks);

    return {
      fileId: node.id,
      filename: node.name,
      mimeType: node.mimeType,
      size: Number(blob.sizeBytes),
      storageKey: blob.s3Key.value(),
      contentUrl: getFileContentPath(node.id),
      buffer,
    };
  }

  async linkFile(input: LinkFileInput): Promise<void> {
    const node = await this.nodeRepo.findById(input.fileId);
    if (node) {
      (node as any)._scope = input.linkedToType as FileScope;
      (node as any)._projectId = input.linkedToId;
      await this.nodeRepo.update(node);
    }
  }

  async uploadFile(input: UploadFileInput): Promise<UploadFileOutput> {
    const res = await this.uploadDirectUseCase.execute({
      userId: input.userId,
      filename: input.filename,
      buffer: input.buffer,
      mimeType: input.mimeType,
      projectId: input.projectId,
      parentId: input.parentId,
      scope:
        input.source === 'library' || input.source === 'paper'
          ? FileScope.Library
          : undefined,
      source: input.source,
    });

    return {
      fileId: res.fileId,
      url: res.url,
      path: res.url,
      filename: res.filename,
      size: res.size,
      mimeType: res.mimeType,
    };
  }

  async uploadBuffer(
    key: string,
    buffer: Buffer,
    contentType = 'application/octet-stream',
  ): Promise<{ path: string; url: string }> {
    await this.driver.put(key, buffer, {
      mimeType: contentType,
      size: buffer.length,
    });
    return {
      path: key,
      url: `/api/files/r2/${encodeURIComponent(key)}`,
    };
  }

  async deleteFile(fileId: string): Promise<void> {
    const node = await this.nodeRepo.findById(fileId);
    if (node && !node.isTrashed()) {
      node.trash();
      await this.nodeRepo.update(node);
    }
  }

  async getFileStream(
    fileId: string,
    range?: { start: number; end: number },
  ): Promise<{
    stream: NodeJS.ReadableStream;
    mimeType: string;
    size: number;
    filename: string;
    contentRange?: string;
  }> {
    const node = await this.nodeRepo.findById(fileId);
    if (!node || node.isTrashed()) {
      throw new NotFoundException(`Storage node not found: ${fileId}`);
    }
    if (!node.blobId) {
      throw new NotFoundException(
        `File has no physical binary payload: ${fileId}`,
      );
    }
    const blob = await this.blobRepo.findById(node.blobId);
    if (!blob) {
      throw new NotFoundException(
        `Physical storage blob not found for node: ${fileId}`,
      );
    }

    const { stream, contentLength, contentRange } = await this.driver.getStream(
      blob.s3Key.value(),
      range,
    );

    return {
      stream,
      mimeType: node.mimeType,
      size: contentLength,
      filename: node.name,
      contentRange,
    };
  }

  async getPresignedDownloadUrl(
    fileId: string,
    expiresInSeconds = 3600,
  ): Promise<string> {
    const node = await this.nodeRepo.findById(fileId);
    if (!node || node.isTrashed()) {
      throw new NotFoundException(`Storage node not found: ${fileId}`);
    }
    if (!node.blobId) {
      throw new NotFoundException(
        `File has no physical binary payload: ${fileId}`,
      );
    }
    const blob = await this.blobRepo.findById(node.blobId);
    if (!blob) {
      throw new NotFoundException(
        `Physical storage blob not found for node: ${fileId}`,
      );
    }
    return this.driver.getPresignedDownloadUrl(blob.s3Key.value(), {
      expiresInSeconds,
      filename: node.name,
    });
  }

  async getPresignedUploadUrl(input: {
    userId: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
  }): Promise<{
    uploadUrl: string;
    storageKey: string;
    fileUuid: string;
    expiresIn: number;
  }> {
    if (this.presignUploadUseCase) {
      return this.presignUploadUseCase.execute(input);
    }
    const cleanExt = (input.filename.split('.').pop() || 'bin').replace(
      /[^a-zA-Z0-9]/g,
      '',
    );
    const fileUuid = crypto.randomUUID();
    const storageKey = `uploads/${input.userId}/${fileUuid}.${cleanExt}`;
    const uploadUrl = await this.driver.getPresignedUploadUrl(storageKey, {
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      expiresInSeconds: 300,
    });
    return {
      uploadUrl,
      storageKey,
      fileUuid,
      expiresIn: 300,
    };
  }

  async checkQuota(
    userId?: string | null,
    projectId?: string | null,
  ): Promise<{ usedBytes: number; maxBytes: number; percentage: number }> {
    if (this.checkQuotaUseCase) {
      return this.checkQuotaUseCase.execute(userId, projectId);
    }
    return { usedBytes: 0, maxBytes: 5 * 1024 * 1024 * 1024, percentage: 0 };
  }
}
