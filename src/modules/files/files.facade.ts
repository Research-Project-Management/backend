import {
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { StorageBlob } from './domain/blob.domain';
import {
  inferMimeType,
  isBlockedExtension,
  isValidUuid,
  sanitizeFilename,
  streamToBuffer,
  validateMagicBytes,
} from './domain/files.policy';
import { StorageQuota } from './domain/quota.domain';
import { StorageLifecycleConfiguration } from './types/adapter.type';
import {
  CompleteFileMultipartInput,
  CompleteFileMultipartOutput,
  CompletePresignedFileInput,
  CompletePresignedFileOutput,
  FileActorContext,
  FilesStreamOptions,
  FilesStreamOutput,
  getFileContentPath,
  IFilesPort,
  InitiateFileMultipartInput,
  InitiateFileMultipartOutput,
  PresignFileUploadInput,
  PresignFileUploadOutput,
  ReadFilesInput,
  ReadFilesOutput,
  RegisterUploadedObjectInput,
  StoreBufferCasResult,
  StreamKeyOutput,
  UploadFilesInput,
  UploadFilesOutput,
} from './types/files.type';
import { BlobService } from './services/blob.service';
import { QuotaService } from './services/quota.service';
import { PresignService } from './services/presign.service';
import { FileStreamService } from './services/stream.service';
import { ThumbnailService } from './services/thumbnail.service';

@Injectable()
export class FilesFacade implements IFilesPort {
  constructor(
    private readonly blobService: BlobService,
    private readonly quotaService: QuotaService,
    private readonly presignService: PresignService,
    private readonly streamService: FileStreamService,
    @Optional() private readonly thumbnailService?: ThumbnailService,
  ) {}

  async uploadFile(input: UploadFilesInput): Promise<UploadFilesOutput> {
    const cleanFilename = sanitizeFilename(input.filename);
    if (isBlockedExtension(cleanFilename)) {
      throw new Error('File extension is prohibited for security reasons');
    }

    const mimeType =
      input.mimeType && input.mimeType !== 'application/octet-stream'
        ? input.mimeType
        : inferMimeType({ filename: cleanFilename, headerBytes: input.buffer });

    validateMagicBytes(input.buffer, mimeType, cleanFilename);

    await this.assertQuotaAvailable(
      input.userId,
      input.projectId ?? null,
      BigInt(input.buffer.length),
    );

    const { blob, isDeduplicated } = await this.storeBuffer(
      input.buffer,
      mimeType,
    );

    try {
      await this.reserveQuota(
        input.userId,
        input.projectId ?? null,
        blob.sizeBytes,
      );
    } catch (err) {
      await this.releaseBlob(blob.id).catch(() => {});
      throw err;
    }

    return {
      fileId: blob.id,
      blobId: blob.id,
      url: getFileContentPath(blob.id),
      path: blob.s3Key.value(),
      filename: cleanFilename,
      size: Number(blob.sizeBytes),
      mimeType,
      isDeduplicated,
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
      url: `/api/v1/files/objects/${encodeURIComponent(key)}`,
    };
  }

  async readOwnedFile(input: ReadFilesInput): Promise<ReadFilesOutput> {
    const { blob, stream } = await this.blobService.openStream(input.fileId);
    const buffer = await streamToBuffer(stream as AsyncIterable<Buffer>);
    const mimeType = inferMimeType({ headerBytes: buffer.subarray(0, 32) });

    return {
      fileId: blob.id,
      filename: blob.id,
      mimeType,
      size: Number(blob.sizeBytes),
      storageKey: blob.s3Key.value(),
      contentUrl: getFileContentPath(blob.id),
      buffer,
    };
  }

  async getOwnedFileStream(
    input: ReadFilesInput & { range?: { start: number; end?: number } },
  ): Promise<{
    stream: NodeJS.ReadableStream;
    mimeType: string;
    size: number;
    filename: string;
    contentRange?: string;
  }> {
    const blob = await this.blobService.findBlobById(input.fileId);
    if (!blob) {
      throw new NotFoundException('Physical storage blob not found');
    }

    const totalSize = Number(blob.sizeBytes);
    const normalizedRange = input.range
      ? {
          start: input.range.start,
          end:
            input.range.end !== undefined
              ? input.range.end
              : Math.max(0, totalSize - 1),
        }
      : undefined;

    const { stream, contentLength, contentRange } =
      await this.blobService.openStream(input.fileId, normalizedRange);

    return {
      stream,
      mimeType: 'application/octet-stream',
      size: contentLength,
      filename: blob.id,
      contentRange,
    };
  }

  async deleteFile(
    fileId: string,
    scope?: { userId?: string | null; projectId?: string | null },
  ): Promise<void> {
    if (scope?.userId || scope?.projectId) {
      const blob = await this.blobService.findBlobById(fileId);
      if (blob) {
        await this.releaseQuota(
          scope.userId,
          scope.projectId,
          blob.sizeBytes,
        ).catch(() => {});
      }
    }
    await this.blobService.releaseBlob(fileId);
  }

  async deleteObject(key: string): Promise<void> {
    await this.blobService.delete(key);
  }

  async ensurePdfThumbnail(input: {
    fileId: string;
    userId?: string;
    projectId?: string | null;
  }): Promise<Buffer | null> {
    const thumbKey = `thumbnails/${input.fileId}.webp`;
    try {
      const exists = await this.blobService.exists(thumbKey);
      if (exists) {
        const { stream } = await this.blobService.getStream(thumbKey);
        return streamToBuffer(stream);
      }
    } catch {
      // Fall through to generate thumbnail from PDF binary
    }

    if (!this.thumbnailService) {
      return null;
    }

    const { stream } = await this.blobService.openStream(input.fileId);
    const pdfBuffer = await streamToBuffer(stream as AsyncIterable<Buffer>);
    const thumbBuffer =
      await this.thumbnailService.generateThumbnail(pdfBuffer);
    if (!thumbBuffer) {
      return null;
    }

    try {
      await this.blobService.put(thumbKey, thumbBuffer, {
        mimeType: 'image/webp',
        size: thumbBuffer.length,
      });
    } catch {
      // Non-fatal if caching generated thumbnail fails
    }

    return thumbBuffer;
  }

  storeBuffer(
    buffer: Buffer,
    mimeType: string,
    onBeforeNewUpload?: (sizeBytes: bigint) => Promise<void>,
  ): Promise<StoreBufferCasResult> {
    return this.blobService.storeBuffer(buffer, mimeType, onBeforeNewUpload);
  }

  registerUploadedObject(
    input: RegisterUploadedObjectInput,
  ): Promise<StoreBufferCasResult> {
    return this.blobService.registerUploadedObject(input);
  }

  presignUpload(
    input: PresignFileUploadInput,
  ): Promise<PresignFileUploadOutput> {
    return this.presignService.presignUpload(input);
  }

  async getPresignedUploadUrl(
    input: PresignFileUploadInput & { scope?: string },
  ) {
    const res = await this.presignUpload(input);
    return {
      uploadUrl: res.uploadUrl || '',
      storageKey: res.storageKey,
      fileUuid: res.fileUuid || res.blob?.id || '',
      expiresIn: res.expiresIn,
      deduplicated: res.deduplicated,
      ...(res.blob
        ? {
            fileId: res.blob.id,
            url: getFileContentPath(res.blob.id),
            filename: res.cleanFilename,
            size: Number(res.blob.sizeBytes),
            mimeType: input.mimeType,
          }
        : {}),
    };
  }

  completePresignedUpload(
    input: CompletePresignedFileInput,
  ): Promise<CompletePresignedFileOutput> {
    return this.presignService.completePresignedUpload(input);
  }

  initiateMultipart(
    input: InitiateFileMultipartInput,
  ): Promise<InitiateFileMultipartOutput> {
    return this.presignService.initiateMultipart(input);
  }

  async initiateMultipartUpload(input: InitiateFileMultipartInput) {
    const res = await this.initiateMultipart(input);
    return {
      sessionId: res.sessionId,
      uploadId: res.uploadId,
      partSize: res.partSize,
      totalParts: res.totalParts,
      deduplicated: res.deduplicated,
      ...(res.blob
        ? {
            fileId: res.blob.id,
            url: getFileContentPath(res.blob.id),
            filename: res.cleanFilename,
            size: Number(res.blob.sizeBytes),
          }
        : {}),
    };
  }

  presignMultipartPart(
    sessionId: string,
    partNumber: number,
    actor?: FileActorContext,
  ): Promise<{ url: string; partNumber: number }> {
    return this.presignService.presignMultipartPart(
      sessionId,
      partNumber,
      actor,
    );
  }

  async getMultipartPartUrl(
    sessionId: string,
    partNumber: number,
    actor?: FileActorContext,
  ): Promise<string> {
    const res = await this.presignMultipartPart(sessionId, partNumber, actor);
    return res.url;
  }

  completeMultipart(
    input: CompleteFileMultipartInput,
  ): Promise<CompleteFileMultipartOutput> {
    return this.presignService.completeMultipart(input);
  }

  async completeMultipartUpload(input: CompleteFileMultipartInput) {
    const res = await this.completeMultipart(input);
    return {
      fileId: res.blob.id,
      blobId: res.blob.id,
      url: getFileContentPath(res.blob.id),
      filename: res.session.filename,
      size: Number(res.blob.sizeBytes),
      mimeType: res.session.mimeType,
    };
  }

  abortMultipart(sessionId: string, actor?: FileActorContext): Promise<void> {
    return this.presignService.abortMultipart(sessionId, actor);
  }

  abortMultipartUpload(
    sessionId: string,
    actor?: FileActorContext,
  ): Promise<void> {
    return this.abortMultipart(sessionId, actor);
  }

  streamBlob(
    blob: Pick<StorageBlob, 's3Key' | 'sizeBytes'> & {
      contentHash?: StorageBlob['contentHash'];
    },
    options?: FilesStreamOptions,
  ): Promise<FilesStreamOutput> {
    return this.streamService.streamBlob(blob, options);
  }

  streamByKey(key: string, rangeHeader?: string): Promise<StreamKeyOutput> {
    return this.streamService.streamByKey(key, rangeHeader);
  }

  async getPresignedDownloadUrl(
    fileIdOrKey: string,
    optionsOrExpires?:
      | number
      | { expiresInSeconds?: number; filename?: string },
    _userId?: string,
  ): Promise<string> {
    const options =
      typeof optionsOrExpires === 'number'
        ? { expiresInSeconds: optionsOrExpires }
        : (optionsOrExpires ?? {});

    if (isValidUuid(fileIdOrKey)) {
      const blob = await this.blobService.findBlobById(fileIdOrKey);
      if (!blob) {
        throw new NotFoundException('Physical storage blob not found');
      }
      return this.streamService.getPresignedDownloadUrl(
        blob.s3Key.value(),
        options,
      );
    }

    return this.streamService.getPresignedDownloadUrl(fileIdOrKey, options);
  }

  openBlobStream(blobId: string, range?: { start: number; end: number }) {
    return this.blobService.openStream(blobId, range);
  }

  statObject(key: string) {
    return this.blobService.stat(key);
  }

  releaseBlob(blobId: string): Promise<void> {
    return this.blobService.releaseBlob(blobId);
  }

  reclaimOrphanBlobs(limit = 100): Promise<number> {
    return this.blobService.reclaimOrphanBlobs(limit);
  }

  cleanupExpiredSessions(limit = 50): Promise<number> {
    return this.presignService.cleanupExpiredSessions(limit);
  }

  applyLifecycleRules(config?: StorageLifecycleConfiguration): Promise<void> {
    return this.blobService.applyLifecycleRules(config);
  }

  getQuota(
    userId?: string | null,
    projectId?: string | null,
  ): Promise<StorageQuota | null> {
    return this.quotaService.getQuota(userId, projectId);
  }

  assertQuotaAvailable(
    userId: string,
    projectId: string | null | undefined,
    requiredBytes: bigint,
  ): Promise<void> {
    return this.quotaService.assertAvailable(userId, projectId, requiredBytes);
  }

  reserveQuota(
    userId: string | null | undefined,
    projectId: string | null | undefined,
    bytes: bigint,
  ): Promise<bigint> {
    return this.quotaService.reserve(userId, projectId, bytes);
  }

  releaseQuota(
    userId: string | null | undefined,
    projectId: string | null | undefined,
    bytes: bigint,
  ): Promise<bigint> {
    return this.quotaService.release(userId, projectId, bytes);
  }
}
