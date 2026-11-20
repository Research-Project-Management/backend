import { Readable } from 'node:stream';
import { BlobStatus } from '../domain/storage-vo';
import { CompletedPart, StorageObjectMetadata } from './adapter.type';

export { BlobStatus };

export enum UploadSessionStatus {
  INITIALIZED = 'INITIALIZED',
  UPLOADING = 'UPLOADING',
  COMPLETED = 'COMPLETED',
  ABORTED = 'ABORTED',
  EXPIRED = 'EXPIRED',
}

export interface StorageBlobRecord {
  readonly id: string;
  readonly contentHashHex: string;
  readonly hashAlgorithm: string;
  readonly sizeBytes: bigint;
  readonly mimeType: string;
  readonly checksumVerified: boolean;
  readonly s3Key: string;
  readonly s3Bucket: string;
  readonly storageClass: string;
  readonly refCount: number;
  readonly status: BlobStatus;
  readonly createdAt: Date;
  readonly tombstoneAt: Date | null;
  readonly claimedAt: Date | null;
}

export interface StorageQuotaRecord {
  readonly spaceId: string;
  readonly usedBytes: bigint;
  readonly maxBytes: bigint;
  readonly updatedAt: Date;
}

export interface UploadSessionRecord {
  readonly id: string;
  readonly spaceId: string;
  readonly userId: string;
  readonly s3UploadId: string;
  readonly s3Key: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly totalSize: bigint;
  readonly partSize: number;
  readonly totalParts: number;
  readonly expectedHashHex: string | null;
  readonly parentId: string | null;
  readonly status: UploadSessionStatus;
  readonly expiresAt: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface BlobRefRecord {
  blobId: string;
  spaceId: string;
  ownerType: string;
  ownerId: string;
  sizeBytes: bigint;
  createdAt: Date;
}

export interface AttachBlobRefInput {
  blobId: string;
  spaceId: string;
  ownerType: string;
  ownerId: string;
  sizeBytes?: bigint;
}

export function getFileContentPath(blobId: string): string {
  return `/api/v1/files/${encodeURIComponent(blobId)}/content`;
}

export function getFileObjectPath(key: string): string {
  return `/api/v1/files/objects/${encodeURIComponent(key)}`;
}

export interface EnsureImageThumbnailOutput {
  thumbnailUrl: string;
  width?: number;
  height?: number;
  format?: string;
}

export interface RequestThumbnailInput {
  fileId: string;
  kind: 'pdf' | 'image';
  width?: number;
  height?: number;
  quality?: number;
}

export interface StoreBufferCasResult {
  blob: StorageBlobRecord;
  isDeduplicated: boolean;
}

export interface RegisterUploadedObjectInput {
  storageKey: string;
  sizeBytes: bigint;
  contentHashHex?: string;
  mimeType?: string;
  checksumVerified?: boolean;
}

export interface FileActorContext {
  userId: string;
  spaceId?: string | null;
}

export interface DeleteFileTarget {
  spaceId: string;
  ownerType?: string;
  ownerId?: string;
}

export interface PresignFileUploadInput {
  userId: string;
  spaceId?: string | null;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  contentHash?: string;
}

export interface PresignFileUploadOutput {
  deduplicated: boolean;
  storageKey: string;
  cleanFilename: string;
  expiresIn: number;
  uploadUrl?: string;
  fileUuid?: string;
  blob?: StorageBlobRecord;
  fileId?: string;
  url?: string;
  filename?: string;
  size?: number;
  mimeType?: string;
}

export interface CompletePresignedFileInput {
  userId: string;
  spaceId?: string | null;
  storageKey: string;
  filename: string;
  sizeBytes?: number;
  mimeType?: string;
  contentHash?: string;
}

export interface CompletePresignedFileOutput {
  blob: StorageBlobRecord;
  fileId: string;
  blobId: string;
  url: string;
  filename: string;
  size: number;
  sizeBytes: bigint;
  mimeType: string;
  cleanFilename: string;
  isDeduplicated: boolean;
}

export interface InitiateFileMultipartInput {
  userId: string;
  spaceId?: string | null;
  parentId?: string | null;
  filename: string;
  mimeType: string;
  totalSize: number;
  expectedHash?: string;
}

export interface InitiateFileMultipartOutput {
  deduplicated: boolean;
  sessionId: string;
  uploadId: string;
  storageKey: string;
  partSize: number;
  totalParts: number;
  cleanFilename: string;
  blob?: StorageBlobRecord;
  fileId?: string;
  url?: string;
  filename?: string;
  size?: number;
}

export interface MultipartPartUrlItem {
  partNumber: number;
  uploadUrl: string;
}

export interface CompleteFileMultipartInput {
  sessionId: string;
  parts: CompletedPart[];
  actor?: FileActorContext;
}

export interface CompleteFileMultipartOutput {
  blob: StorageBlobRecord;
  session: UploadSessionRecord;
  isDeduplicated: boolean;
  fileId: string;
  blobId: string;
  url: string;
  filename: string;
  size: number;
  mimeType: string;
}

export interface FilesStreamOptions {
  rangeHeader?: string;
  ifNoneMatch?: string;
  mimeType?: string;
  filename?: string;
}

export interface StreamBlobTarget {
  s3Key: string;
  sizeBytes: bigint | number;
  contentHashHex?: string | null;
}

export interface FilesStreamOutput {
  stream: Readable | null;
  statusCode: number;
  mimeType: string;
  contentLength: number;
  contentRange?: string;
  filename: string;
  etag?: string;
}

export interface StreamKeyOutput {
  stream: NodeJS.ReadableStream;
  contentType: string;
  contentLength: number;
  contentRange?: string;
}

export interface UploadFilesInput {
  userId: string;
  filename: string;
  buffer: Buffer;
  mimeType: string;
  spaceId?: string | null;
  ownerType?: string;
  ownerId?: string;
}

export interface UploadFilesOutput {
  fileId: string;
  blobId: string;
  url: string;
  path: string;
  filename: string;
  size: number;
  mimeType: string;
  isDeduplicated: boolean;
}

export interface ReadFilesInput {
  fileId: string;
  userId?: string;
  spaceId?: string;
}

export interface ReadFilesOutput {
  fileId: string;
  filename: string;
  mimeType: string;
  size: number;
  storageKey: string;
  contentUrl: string;
  buffer: Buffer;
}

export interface QuotaSummaryOutput {
  usedBytes: number;
  maxBytes: number;
  remainingBytes: number;
  usagePercent: number;
  scope: 'personal' | 'project';
  spaceId: string;
}

export type AuthorizedBlobContentResult =
  | { kind: 'redirect'; location: string }
  | { kind: 'not-modified'; etag: string }
  | {
      kind: 'stream';
      statusCode: number;
      stream: Readable | null;
      mimeType: string;
      filename: string;
      contentLength: number;
      contentRange?: string;
      etag: string;
      isDownload: boolean;
    };

export interface AuthorizedObjectStreamResult {
  statusCode: number;
  stream: NodeJS.ReadableStream;
  mimeType: string;
  filename: string;
  contentLength: number;
  contentRange?: string;
  cacheControl: string;
}

/**
 * Unified Deep-Module Port for FilesModule consumers.
 */
export interface IFilesPort {
  // ── 1. Upload & Multipart Orchestration ──
  uploadFile(input: UploadFilesInput): Promise<UploadFilesOutput>;
  registerUploadedObject(
    input: RegisterUploadedObjectInput,
  ): Promise<StoreBufferCasResult>;
  presignUpload(
    input: PresignFileUploadInput,
  ): Promise<PresignFileUploadOutput>;
  completePresignedUpload(
    input: CompletePresignedFileInput,
  ): Promise<CompletePresignedFileOutput>;
  initiateMultipart(
    input: InitiateFileMultipartInput,
  ): Promise<InitiateFileMultipartOutput>;
  getMultipartPartUrl(
    sessionId: string,
    partNumber: number,
    actor?: FileActorContext,
  ): Promise<string>;
  presignMultipartParts(
    sessionId: string,
    partNumbers: number[],
    actor?: FileActorContext,
  ): Promise<MultipartPartUrlItem[]>;
  completeMultipart(
    input: CompleteFileMultipartInput,
  ): Promise<CompleteFileMultipartOutput>;
  abortMultipart(sessionId: string, actor?: FileActorContext): Promise<void>;

  // ── 2. Delivery & Internal Binary IO ──
  getPresignedDownloadUrl(
    fileIdOrKey: string,
    optionsOrExpires?:
      number | { expiresInSeconds?: number; filename?: string },
    userId?: string,
  ): Promise<string>;
  createSignedContentUrl(
    blobId: string,
    options?: {
      expiresInSeconds?: number;
      filename?: string;
      download?: boolean;
    },
  ): string;
  createSignedObjectUrl(key: string, expiresInSeconds?: number): string;
  readOwnedFile(input: ReadFilesInput): Promise<ReadFilesOutput>;
  getOwnedFileStream(
    input: ReadFilesInput & { range?: { start: number; end?: number } },
  ): Promise<{
    stream: NodeJS.ReadableStream;
    mimeType: string;
    size: number;
    filename: string;
    contentRange?: string;
  }>;
  streamBlob(
    blob: StreamBlobTarget,
    options?: FilesStreamOptions,
  ): Promise<FilesStreamOutput>;
  openBlobStream(
    blobId: string,
    range?: { start: number; end: number },
  ): Promise<{
    blob: StorageBlobRecord;
    stream: NodeJS.ReadableStream;
    contentLength: number;
    contentRange?: string;
  }>;
  putObject(
    key: string,
    data: Buffer | Readable,
    options?: { mimeType?: string; size?: number },
  ): Promise<void>;
  getObjectStream(
    key: string,
    range?: { start: number; end: number },
  ): Promise<{
    stream: Readable;
    contentLength: number;
    contentRange?: string;
  }>;
  statObject(key: string): Promise<StorageObjectMetadata>;
  deleteObject(key: string): Promise<void>;

  // ── 3. CAS Reference & Quota Ledger ──
  findBlobById(blobId: string): Promise<StorageBlobRecord | null>;
  findBlobByHash(contentHashHex: string): Promise<StorageBlobRecord | null>;
  acquireBlob(blobId: string): Promise<StorageBlobRecord | null>;
  releaseBlob(blobId: string): Promise<void>;
  deleteFile(fileId: string, target?: DeleteFileTarget): Promise<void>;
  attachBlobRef(
    input: AttachBlobRefInput,
  ): Promise<{ created: boolean; ref: BlobRefRecord | null }>;
  detachBlobRef(ownerType: string, ownerId: string): Promise<boolean>;
  getQuota(spaceId?: string | null): Promise<StorageQuotaRecord | null>;
  reserveQuota(
    spaceId: string | null | undefined,
    bytes: bigint,
  ): Promise<bigint>;
  releaseQuota(
    spaceId: string | null | undefined,
    bytes: bigint,
  ): Promise<bigint>;

  // ── 4. Async & Coalesced Derivatives ──
  getThumbnailUrl(blobId: string, contentHashHex?: string): string;
  requestThumbnail(input: RequestThumbnailInput): Promise<boolean>;
  ensurePdfThumbnail(input: {
    fileId: string;
    userId?: string;
    spaceId?: string | null;
  }): Promise<Buffer | null>;
  ensureImageThumbnail(input: {
    fileId: string;
    width?: number;
    height?: number;
    quality?: number;
  }): Promise<EnsureImageThumbnailOutput | null>;
}
