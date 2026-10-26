import {
  Injectable,
  Inject,
  Optional,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import {
  IStoragePort,
  ReadOwnedFileInput,
  ReadOwnedFileOutput,
  LinkFileInput,
  UploadFileInput,
  UploadFileOutput,
  getFileContentPath,
} from './storage.port';
import { STORAGE_NODE_REPOSITORY } from './storage.tokens';
import {
  IStorageNodeRepository,
  DriveService,
  TrashService,
  StorageAccessPolicy,
  FileScope,
} from './drive';
import { BlobService, streamToBuffer } from './core';
import { UploadService } from './transfer/services/upload.service';
import { MultipartService } from './transfer/services/multipart.service';
import { StreamService } from './transfer/services/stream.service';
import { PdfThumbnailService } from './worker/services/pdf-thumbnail.service';

/**
 * StorageFacade: The Single Public Reception Desk for Storage
 * Implements IStoragePort for complete platform-wide storage services:
 * CAS deduplication, streaming, presigned URLs, PDF thumbnails, and entity attachments.
 */
@Injectable()
export class StorageFacade implements IStoragePort {
  constructor(
    private readonly blobService: BlobService,
    @Inject(STORAGE_NODE_REPOSITORY)
    private readonly nodeRepo: IStorageNodeRepository,
    private readonly uploadService: UploadService,
    private readonly multipartService: MultipartService,
    private readonly trashService: TrashService,
    private readonly streamService: StreamService,
    private readonly driveService: DriveService,
    private readonly accessPolicy: StorageAccessPolicy,
    @Optional()
    private readonly pdfThumbnailService?: PdfThumbnailService,
  ) {}

  private async verifyNodeAccess(
    node: { id: string; authorId: string; projectId: string | null },
    userId?: string,
    projectId?: string | null,
  ): Promise<void> {
    if (projectId && node.projectId && node.projectId !== projectId) {
      throw new ForbiddenException(
        'Access denied: Storage node belongs to a different project context',
      );
    }
    if (!userId || userId === 'system') return;
    await this.accessPolicy.assertCanAccess(userId, node.id, 'read');
  }

  private async resolveActiveNodeAndBlob(
    fileId: string,
    userId?: string,
    projectId?: string | null,
  ) {
    const node = await this.nodeRepo.findById(fileId);
    if (!node || node.isTrashed()) {
      throw new NotFoundException(`Storage node not found: ${fileId}`);
    }
    await this.verifyNodeAccess(node, userId, projectId);
    if (!node.blobId) {
      throw new NotFoundException(
        `File has no physical binary payload: ${fileId}`,
      );
    }
    const blob = await this.blobService.findBlobById(node.blobId);
    if (!blob) {
      throw new NotFoundException(
        `Physical storage blob not found for node: ${fileId}`,
      );
    }
    return { node, blob };
  }

  async assertFileAccess(
    fileId: string,
    userId?: string,
    projectId?: string | null,
  ): Promise<void> {
    const node = await this.nodeRepo.findById(fileId);
    if (!node || node.isTrashed()) {
      throw new NotFoundException(`Storage node not found: ${fileId}`);
    }
    await this.verifyNodeAccess(node, userId, projectId);
  }

  async readOwnedFile(input: ReadOwnedFileInput): Promise<ReadOwnedFileOutput> {
    const { node, blob } = await this.resolveActiveNodeAndBlob(
      input.fileId,
      input.userId,
      input.projectId,
    );

    const { stream } = await this.blobService.getStream(blob.s3Key.value());
    const buffer = await streamToBuffer(stream);

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

  async getOwnedFileStream(
    input: ReadOwnedFileInput & { range?: { start: number; end: number } },
  ): Promise<{
    stream: NodeJS.ReadableStream;
    mimeType: string;
    size: number;
    filename: string;
    contentRange?: string;
  }> {
    const { node, blob } = await this.resolveActiveNodeAndBlob(
      input.fileId,
      input.userId,
      input.projectId,
    );

    const { stream, contentLength, contentRange } =
      await this.blobService.getStream(blob.s3Key.value(), input.range);

    return {
      stream,
      mimeType: node.mimeType,
      size: contentLength,
      filename: node.name,
      contentRange,
    };
  }

  async ensurePdfThumbnail(input: {
    fileId: string;
    userId?: string;
    projectId?: string | null;
  }): Promise<Buffer | null> {
    const { node, blob } = await this.resolveActiveNodeAndBlob(
      input.fileId,
      input.userId,
      input.projectId,
    );

    const thumbKey = `thumbnails/${blob.id}.webp`;
    try {
      const exists = await this.blobService.exists(thumbKey);
      if (exists) {
        const { stream } = await this.blobService.getStream(thumbKey);
        return streamToBuffer(stream);
      }
    } catch {
      // Fall through to generate thumbnail from PDF binary
    }

    if (!this.pdfThumbnailService) {
      return null;
    }

    const { stream } = await this.blobService.getStream(blob.s3Key.value());
    const pdfBuffer = await streamToBuffer(stream);
    const thumbBuffer =
      await this.pdfThumbnailService.generateThumbnail(pdfBuffer);
    if (!thumbBuffer) {
      return null;
    }

    try {
      await this.blobService.put(thumbKey, thumbBuffer, {
        mimeType: 'image/webp',
        size: thumbBuffer.length,
      });
      node.updateMetadata({
        ...(node.metadata || {}),
        thumbnail: `/api/v1/storage/files/r2/${encodeURIComponent(thumbKey)}`,
      });
      await this.nodeRepo.update(node);
    } catch {
      // Non-fatal if persisting cached thumbnail fails
    }

    return thumbBuffer;
  }

  async linkFile(input: LinkFileInput): Promise<void> {
    await this.driveService.linkScope(
      input.fileId,
      input.linkedToType,
      input.linkedToId,
    );
  }

  async uploadFile(input: UploadFileInput): Promise<UploadFileOutput> {
    const res = await this.uploadService.upload({
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
    await this.blobService.put(key, buffer, {
      mimeType: contentType,
      size: buffer.length,
    });
    return {
      path: key,
      url: `/api/v1/storage/files/r2/${encodeURIComponent(key)}`,
    };
  }

  async deleteFile(fileId: string): Promise<void> {
    await this.trashService.softDelete(fileId);
  }

  async deleteObject(key: string): Promise<void> {
    await this.blobService.delete(key);
  }

  async getPresignedDownloadUrl(
    fileId: string,
    expiresInSeconds = 3600,
    userId?: string,
  ): Promise<string> {
    return this.streamService.getPresignedDownloadUrl(
      fileId,
      expiresInSeconds,
      userId,
    );
  }

  async getPresignedUploadUrl(input: {
    userId: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    contentHash?: string;
    projectId?: string | null;
    parentId?: string | null;
    scope?: FileScope | string;
  }): Promise<{
    uploadUrl: string;
    storageKey: string;
    fileUuid: string;
    expiresIn: number;
    deduplicated?: boolean;
    fileId?: string;
    url?: string;
    filename?: string;
    size?: number;
    mimeType?: string;
  }> {
    return this.uploadService.presign({
      ...input,
      scope: input.scope as FileScope | undefined,
    });
  }

  async completePresignedUpload(input: {
    userId: string;
    storageKey: string;
    filename: string;
    sizeBytes?: number;
    mimeType?: string;
    projectId?: string | null;
    parentId?: string | null;
    scope?: FileScope | string;
    contentHash?: string;
  }): Promise<{
    fileId: string;
    blobId: string;
    url: string;
    filename: string;
    size: number;
    mimeType: string;
  }> {
    const res = await this.uploadService.complete({
      userId: input.userId,
      storageKey: input.storageKey,
      filename: input.filename,
      sizeBytes: input.sizeBytes,
      mimeType: input.mimeType,
      projectId: input.projectId,
      parentId: input.parentId,
      scope: input.scope as FileScope | undefined,
      contentHash: input.contentHash,
    });
    return {
      fileId: res.fileId,
      blobId: res.blobId,
      url: res.url,
      filename: res.filename,
      size: res.size,
      mimeType: res.mimeType,
    };
  }

  async initiateMultipartUpload(input: {
    userId: string;
    filename: string;
    mimeType: string;
    totalSize: number;
    projectId?: string | null;
    parentId?: string | null;
    scope?: FileScope | string;
    expectedHash?: string;
  }): Promise<{
    sessionId: string;
    uploadId: string;
    partSize: number;
    totalParts: number;
  }> {
    return this.multipartService.initiate({
      ...input,
      scope: input.scope as FileScope | undefined,
    });
  }

  async getMultipartPartUrl(
    sessionId: string,
    partNumber: number,
    actor?: { userId: string; projectId?: string | null },
  ): Promise<string> {
    return this.multipartService.getPartUrl(sessionId, partNumber, actor);
  }

  async completeMultipartUpload(input: {
    sessionId: string;
    parts: { partNumber: number; eTag: string }[];
    actor?: { userId: string; projectId?: string | null };
  }): Promise<{
    fileId: string;
    blobId: string;
    url: string;
    filename: string;
    size: number;
  }> {
    return this.multipartService.complete(input);
  }

  async abortMultipartUpload(
    sessionId: string,
    actor?: { userId: string; projectId?: string | null },
  ): Promise<void> {
    await this.multipartService.abort(sessionId, actor);
  }
}
