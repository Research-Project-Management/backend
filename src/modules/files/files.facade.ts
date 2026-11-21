import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Readable } from 'node:stream';
import {
  DEFAULT_STORAGE_QUOTA_BYTES,
  FILES_JOB_GENERATE_THUMBNAIL,
  FILES_MEDIA_QUEUE,
  STORAGE_ADAPTER,
} from './files.constant';
import { ByteRange, StorageKey } from './domain/storage-vo';
import {
  classifyObjectKey,
  cleanUuid,
  inferMimeType,
  isValidUuid,
  sanitizeFilename,
  streamToBuffer,
} from './domain/files.policy';
import { BlobRepository } from './repositories/blob.repository';
import { QuotaRepository } from './repositories/quota.repository';
import { IStorageAdapter } from './types/adapter.type';
import {
  AttachBlobRefInput,
  AuthorizedBlobContentResult,
  AuthorizedObjectStreamResult,
  BlobRefRecord,
  BlobStatus,
  CompleteFileMultipartInput,
  CompleteFileMultipartOutput,
  CompletePresignedFileInput,
  CompletePresignedFileOutput,
  DeleteFileTarget,
  EnsureImageThumbnailOutput,
  FileActorContext,
  FilesStreamOptions,
  FilesStreamOutput,
  getFileContentPath,
  getFileObjectPath,
  IFilesPort,
  InitiateFileMultipartInput,
  InitiateFileMultipartOutput,
  MultipartPartUrlItem,
  PresignFileUploadInput,
  PresignFileUploadOutput,
  QuotaSummaryOutput,
  ReadFilesInput,
  ReadFilesOutput,
  RegisterUploadedObjectInput,
  RequestThumbnailInput,
  StorageBlobRecord,
  StorageQuotaRecord,
  StoreBufferCasResult,
  StreamBlobTarget,
  StreamKeyOutput,
  UploadFilesInput,
  UploadFilesOutput,
} from './types/files.type';
import { FileAccessService } from './services/access.service';
import { BlobService } from './services/blob.service';
import { ThumbnailService } from './services/thumbnail.service';
import { FilesUploadService } from './services/upload.service';

@Injectable()
export class FilesFacade implements IFilesPort {
  private readonly logger = new Logger(FilesFacade.name);

  constructor(
    @Inject(STORAGE_ADAPTER) private readonly driver: IStorageAdapter,
    private readonly blobService: BlobService,
    private readonly blobRepo: BlobRepository,
    private readonly quotaRepo: QuotaRepository,
    private readonly uploadService: FilesUploadService,
    @Optional() private readonly thumbnailService?: ThumbnailService,
    @Optional() private readonly accessService?: FileAccessService,
    @Optional()
    @InjectQueue(FILES_MEDIA_QUEUE)
    private readonly mediaQueue?: Queue,
  ) {}

  uploadFile(input: UploadFilesInput): Promise<UploadFilesOutput> {
    return this.uploadService.uploadFile(input);
  }

  uploadPublicImage(input: {
    buffer: Buffer;
    filename: string;
    mimeType?: string;
  }) {
    return this.uploadService.uploadPublicImage(input);
  }

  presignUpload(
    input: PresignFileUploadInput,
  ): Promise<PresignFileUploadOutput> {
    return this.uploadService.presignUpload(input);
  }

  completePresignedUpload(
    input: CompletePresignedFileInput,
  ): Promise<CompletePresignedFileOutput> {
    return this.uploadService.completePresignedUpload(input);
  }

  initiateMultipart(
    input: InitiateFileMultipartInput,
  ): Promise<InitiateFileMultipartOutput> {
    return this.uploadService.initiateMultipart(input);
  }

  async getMultipartPartUrl(
    sessionId: string,
    partNumber: number,
    actor?: FileActorContext,
  ): Promise<string> {
    const [item] = await this.uploadService.presignMultipartParts(
      sessionId,
      [partNumber],
      actor,
    );
    return item.uploadUrl;
  }

  presignMultipartParts(
    sessionId: string,
    partNumbers: number[],
    actor?: FileActorContext,
  ): Promise<MultipartPartUrlItem[]> {
    return this.uploadService.presignMultipartParts(
      sessionId,
      partNumbers,
      actor,
    );
  }

  completeMultipart(
    input: CompleteFileMultipartInput,
  ): Promise<CompleteFileMultipartOutput> {
    return this.uploadService.completeMultipart(input);
  }

  abortMultipart(sessionId: string, actor?: FileActorContext): Promise<void> {
    return this.uploadService.abortMultipart(sessionId, actor);
  }

  registerUploadedObject(
    input: RegisterUploadedObjectInput,
  ): Promise<StoreBufferCasResult> {
    return this.blobService.registerUploadedObject(input);
  }

  private async resolveBlobMime(
    blob: StorageBlobRecord,
    headerBytes?: Buffer,
  ): Promise<string> {
    if (blob.mimeType && blob.mimeType !== 'application/octet-stream')
      return blob.mimeType;
    if (headerBytes) return inferMimeType({ headerBytes });
    if (blob.sizeBytes <= 0n) return 'application/octet-stream';
    try {
      const end = Math.min(31, Number(blob.sizeBytes) - 1);
      const { stream } = await this.driver.getStream(blob.s3Key, {
        start: 0,
        end,
      });
      return inferMimeType({
        headerBytes: await streamToBuffer(stream as AsyncIterable<Buffer>),
      });
    } catch {
      return 'application/octet-stream';
    }
  }

  async readOwnedFile(input: ReadFilesInput): Promise<ReadFilesOutput> {
    const { blob, stream } = await this.blobService.openStream(input.fileId);
    const buffer = await streamToBuffer(stream as AsyncIterable<Buffer>);
    return {
      fileId: blob.id,
      filename: blob.id,
      mimeType: await this.resolveBlobMime(blob, buffer.subarray(0, 32)),
      size: Number(blob.sizeBytes),
      storageKey: blob.s3Key,
      contentUrl: getFileContentPath(blob.id),
      buffer,
    };
  }

  async getOwnedFileStream(
    input: ReadFilesInput & { range?: { start: number; end?: number } },
  ) {
    const blob = await this.blobRepo.findById(input.fileId);
    if (!blob) throw new NotFoundException('Physical storage blob not found');

    const totalSize = Number(blob.sizeBytes);
    const range = input.range
      ? {
          start: input.range.start,
          end: input.range.end ?? Math.max(0, totalSize - 1),
        }
      : undefined;
    const { stream, contentLength, contentRange } = await this.driver.getStream(
      blob.s3Key,
      range,
    );

    return {
      stream,
      mimeType: blob.mimeType || 'application/octet-stream',
      size: contentLength,
      filename: blob.id,
      contentRange,
    };
  }

  async deleteFile(fileId: string, target?: DeleteFileTarget): Promise<void> {
    if (target?.ownerType && target?.ownerId) {
      const detached = await this.detachBlobRef(
        target.ownerType,
        target.ownerId,
      );
      if (detached) return;
    }

    const targetSpaceId = target?.spaceId?.trim() || null;
    if (targetSpaceId) {
      const blob = await this.blobRepo.findById(fileId);
      if (blob) {
        await this.quotaRepo
          .decrementUsage(targetSpaceId, blob.sizeBytes)
          .catch(() => {});
      }
    }
    await this.blobRepo.decrementRefCount(fileId);
  }

  async attachBlobRef(
    input: AttachBlobRefInput,
  ): Promise<{ created: boolean; ref: BlobRefRecord | null }> {
    const fallbackBytes = input.sizeBytes ?? 0n;
    const { created, ref } = await this.blobRepo.attachRef(input);
    if (!created) return { created: false, ref };

    const effectiveBytes = ref.sizeBytes ?? fallbackBytes;
    try {
      await this.quotaRepo.incrementUsage(input.spaceId, effectiveBytes);
      await this.blobRepo.incrementRefCount(input.blobId);
      return { created: true, ref };
    } catch (err) {
      await this.blobRepo
        .detachRef(input.ownerType, input.ownerId)
        .catch(() => undefined);
      throw err;
    }
  }

  async detachBlobRef(ownerType: string, ownerId: string): Promise<boolean> {
    const deleted = await this.blobRepo.detachRef(ownerType, ownerId);
    if (!deleted) return false;
    await this.quotaRepo
      .decrementUsage(deleted.spaceId, deleted.sizeBytes)
      .catch(() => {});
    await this.blobRepo.decrementRefCount(deleted.blobId).catch(() => {});
    return true;
  }

  async assertSpaceAccess(
    userId: string,
    spaceId?: string | null,
  ): Promise<string | undefined> {
    const resolvedSpaceId = cleanUuid(spaceId) ?? undefined;
    await this.accessService?.assertSpaceAccess(userId, resolvedSpaceId);
    return resolvedSpaceId;
  }

  async getQuotaSummary(
    userId: string,
    rawSpaceId?: string,
  ): Promise<QuotaSummaryOutput> {
    const explicitSpaceId = cleanUuid(rawSpaceId) ?? null;
    await this.accessService?.assertSpaceAccess(userId, explicitSpaceId);
    const targetSpaceId = explicitSpaceId ?? userId;
    const isProject = Boolean(explicitSpaceId && explicitSpaceId !== userId);
    const quota = await this.quotaRepo.findBySpaceId(targetSpaceId);
    const usedBytes = Number(quota?.usedBytes ?? 0n);
    const maxBytes = Number(quota?.maxBytes ?? DEFAULT_STORAGE_QUOTA_BYTES);
    const remainingBytes = Math.max(0, maxBytes - usedBytes);
    const usagePercent =
      maxBytes > 0 ? Number(((usedBytes / maxBytes) * 100).toFixed(2)) : 0;

    return {
      usedBytes,
      maxBytes,
      remainingBytes,
      usagePercent,
      scope: isProject ? 'project' : 'personal',
      spaceId: targetSpaceId,
    };
  }

  async getAuthorizedDownloadUrl(
    userId: string,
    blobId: string,
    filename?: string,
  ): Promise<{ url: string; expiresIn: number }> {
    if (!isValidUuid(blobId)) {
      throw new NotFoundException('File blob not found');
    }
    if (this.accessService) {
      const allowed = await this.accessService.canAccessBlob(userId, blobId);
      if (!allowed) {
        throw new ForbiddenException('You do not have access to this file');
      }
    }
    const cleanName = filename ? sanitizeFilename(filename) : undefined;
    const expiresIn = 300;
    const url = await this.getPresignedDownloadUrl(blobId, {
      expiresInSeconds: expiresIn,
      filename: cleanName,
    });
    return { url, expiresIn };
  }

  async resolveAuthorizedBlobContent(input: {
    blobId: string;
    userId?: string;
    exp?: string;
    sig?: string;
    filename?: string;
    isDownload: boolean;
    redirect?: boolean;
    ifNoneMatch?: string;
    rangeHeader?: string;
  }): Promise<AuthorizedBlobContentResult> {
    if (!isValidUuid(input.blobId)) {
      throw new NotFoundException('File blob not found');
    }
    if (this.accessService) {
      await this.accessService.assertBlobReadAccess(input.blobId, input);
    } else if (!input.userId) {
      throw new UnauthorizedException(
        'Authentication or signed access token is required',
      );
    }

    const blob = await this.blobRepo.findById(input.blobId);
    if (!blob || blob.status !== BlobStatus.READY) {
      throw new NotFoundException('File blob not found');
    }

    const safeFilename = input.filename
      ? sanitizeFilename(input.filename)
      : blob.id;

    const preferRedirect =
      input.redirect ?? this.driver.supportsDirectDownload === true;
    if (preferRedirect) {
      const location = await this.getPresignedDownloadUrl(blob.id, {
        expiresInSeconds: 300,
        filename: safeFilename,
      });
      return { kind: 'redirect', location };
    }

    const etag = `"${blob.contentHashHex}"`;
    if (input.ifNoneMatch && input.ifNoneMatch === etag && !input.rangeHeader) {
      return { kind: 'not-modified', etag };
    }

    const resolvedMime = await this.resolveBlobMime(blob);
    const streamRes = await this.streamBlob(blob, {
      rangeHeader: input.rangeHeader,
      mimeType: resolvedMime,
      filename: safeFilename,
    });

    return {
      kind: 'stream',
      statusCode: streamRes.statusCode,
      stream: streamRes.stream,
      mimeType: streamRes.mimeType,
      filename: streamRes.filename,
      contentLength: streamRes.contentLength,
      contentRange: streamRes.contentRange,
      etag: streamRes.etag || etag,
      isDownload: input.isDownload,
    };
  }

  async resolveAuthorizedObjectStream(input: {
    rawKey: string;
    userId?: string;
    exp?: string;
    sig?: string;
    rangeHeader?: string;
  }): Promise<AuthorizedObjectStreamResult> {
    let key: string;
    let isPublicAsset: boolean;

    if (this.accessService) {
      ({ key, isPublicAsset } = this.accessService.resolveObjectAccess(
        input.rawKey,
        input,
      ));
    } else {
      const classified = classifyObjectKey(input.rawKey);
      if (classified.isDerivative && !input.userId) {
        throw new UnauthorizedException(
          'Authentication or signed access token is required',
        );
      }
      ({ key, isPublicAsset } = classified);
    }

    const output = await this.streamByKey(key, input.rangeHeader);
    return {
      statusCode: output.contentRange ? 206 : 200,
      stream: output.stream,
      mimeType: inferMimeType({ filename: key }),
      filename: key.split('/').pop() || 'file',
      contentLength: output.contentLength,
      contentRange: output.contentRange,
      cacheControl: isPublicAsset
        ? 'public, max-age=86400'
        : 'private, max-age=3600',
    };
  }

  async streamBlob(
    blob: StreamBlobTarget,
    options?: FilesStreamOptions,
  ): Promise<FilesStreamOutput> {
    const mimeType = options?.mimeType || 'application/octet-stream';
    const filename = options?.filename || 'download';
    const totalSize = Number(blob.sizeBytes);
    const etag = blob.contentHashHex ? `"${blob.contentHashHex}"` : undefined;

    if (etag && options?.ifNoneMatch === etag && !options.rangeHeader) {
      return {
        stream: null,
        statusCode: 304,
        mimeType,
        contentLength: 0,
        filename,
        etag,
      };
    }

    const byteRange = ByteRange.parse(options?.rangeHeader, totalSize);
    const { stream } = await this.driver.getStream(
      blob.s3Key,
      byteRange ? { start: byteRange.start, end: byteRange.end } : undefined,
    );

    return {
      stream,
      statusCode: byteRange ? 206 : 200,
      mimeType,
      contentLength: byteRange ? byteRange.length : totalSize,
      ...(byteRange ? { contentRange: byteRange.getContentRangeHeader() } : {}),
      filename,
      etag,
    };
  }

  async streamByKey(
    key: string,
    rangeHeader?: string,
  ): Promise<StreamKeyOutput> {
    let range: { start: number; end: number } | undefined;
    if (rangeHeader) {
      const stat = await this.driver.stat(key);
      const parsed = ByteRange.parse(rangeHeader, stat.size);
      if (parsed) range = { start: parsed.start, end: parsed.end };
    }
    const res = await this.driver.getStream(key, range);
    return {
      stream: res.stream,
      contentType: 'application/octet-stream',
      contentLength: res.contentLength,
      contentRange: res.contentRange,
    };
  }

  createSignedContentUrl(
    blobId: string,
    options?: {
      expiresInSeconds?: number;
      filename?: string;
      download?: boolean;
    },
  ): string {
    return this.accessService
      ? this.accessService.signBlobUrl(blobId, options)
      : getFileContentPath(blobId);
  }

  createSignedObjectUrl(key: string, expiresInSeconds = 3600): string {
    return this.accessService
      ? this.accessService.signObjectUrl(key, expiresInSeconds)
      : getFileObjectPath(key);
  }

  async getPresignedDownloadUrl(
    fileIdOrKey: string,
    optionsOrExpires?:
      number | { expiresInSeconds?: number; filename?: string },
    _userId?: string,
  ): Promise<string> {
    const options =
      typeof optionsOrExpires === 'number'
        ? { expiresInSeconds: optionsOrExpires }
        : (optionsOrExpires ?? {});

    if (isValidUuid(fileIdOrKey)) {
      const blob = await this.blobRepo.findById(fileIdOrKey);
      if (!blob) {
        throw new NotFoundException('Physical storage blob not found');
      }
      return this.driver.getPresignedDownloadUrl(blob.s3Key, options);
    }

    return this.driver.getPresignedDownloadUrl(fileIdOrKey, options);
  }

  openBlobStream(blobId: string, range?: { start: number; end: number }) {
    return this.blobService.openStream(blobId, range);
  }

  statObject(key: string) {
    return this.driver.stat(key);
  }

  findBlobById(blobId: string): Promise<StorageBlobRecord | null> {
    return this.blobRepo.findById(blobId);
  }

  findBlobByHash(contentHashHex: string): Promise<StorageBlobRecord | null> {
    return this.blobRepo.findByHash(contentHashHex);
  }

  acquireBlob(blobId: string): Promise<StorageBlobRecord | null> {
    return this.blobRepo.incrementRefCount(blobId);
  }

  async releaseBlob(blobId: string): Promise<void> {
    await this.blobRepo.decrementRefCount(blobId);
  }

  putObject(
    key: string,
    data: Buffer | Readable,
    options?: { mimeType?: string; size?: number },
  ): Promise<void> {
    return this.driver.put(key, data, options);
  }

  getObjectStream(
    key: string,
    range?: { start: number; end: number },
  ): Promise<{
    stream: Readable;
    contentLength: number;
    contentRange?: string;
  }> {
    return this.driver.getStream(key, range);
  }

  deleteObject(key: string): Promise<void> {
    return this.driver.delete(key);
  }

  getQuota(spaceId?: string | null): Promise<StorageQuotaRecord | null> {
    return this.quotaRepo.findBySpaceId(spaceId);
  }

  reserveQuota(
    spaceId: string | null | undefined,
    bytes: bigint,
  ): Promise<bigint> {
    return this.quotaRepo.incrementUsage(spaceId, bytes);
  }

  releaseQuota(
    spaceId: string | null | undefined,
    bytes: bigint,
  ): Promise<bigint> {
    return this.quotaRepo.decrementUsage(spaceId, bytes);
  }

  async requestThumbnail(input: RequestThumbnailInput): Promise<boolean> {
    if (!input.fileId || !this.mediaQueue) return false;
    try {
      await this.mediaQueue.add(FILES_JOB_GENERATE_THUMBNAIL, input, {
        jobId: `${input.kind}:${input.fileId}`,
        removeOnComplete: true,
        removeOnFail: 100,
      });
      return true;
    } catch (err: unknown) {
      this.logger.warn(
        `Failed enqueueing media thumbnail job for ${input.fileId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  ensurePdfThumbnail(input: {
    fileId: string;
    userId?: string;
    spaceId?: string | null;
  }): Promise<Buffer | null> {
    return this.thumbnailService
      ? this.thumbnailService.ensurePdfThumbnail(input)
      : Promise.resolve(null);
  }

  ensureImageThumbnail(input: {
    fileId: string;
    width?: number;
    height?: number;
    quality?: number;
  }): Promise<EnsureImageThumbnailOutput | null> {
    return this.thumbnailService
      ? this.thumbnailService.ensureImageThumbnail(input)
      : Promise.resolve(null);
  }

  getThumbnailUrl(blobId: string, contentHashHex?: string): string {
    if (this.thumbnailService) {
      return this.thumbnailService.getThumbnailUrl(blobId, contentHashHex);
    }
    if (contentHashHex && /^[a-f0-9]{64}$/i.test(contentHashHex)) {
      return getFileObjectPath(
        StorageKey.forDerivative(contentHashHex, 'thumb').value(),
      );
    }
    return getFileObjectPath(`thumbnails/${blobId}.webp`);
  }
}
