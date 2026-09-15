import { Injectable, Inject, NotFoundException } from '@nestjs/common';
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
import { FileScope } from './domain/value-objects/file-scope.vo';

/**
 * StorageFacade: The Single Public Reception Desk for Storage
 * Implements IStoragePort for complete backward compatibility with Library, Work-Item, AI, and Document modules.
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
}
