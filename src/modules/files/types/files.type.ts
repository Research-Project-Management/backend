import { Readable } from 'node:stream';
import { StorageBlob } from '../domain/blob.domain';
import { StorageQuota } from '../domain/quota.domain';
import { UploadSession } from '../domain/session.domain';
import {
  CompletedPart,
  StorageLifecycleConfiguration,
  StorageObjectMetadata,
} from './adapter.type';

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

export interface StoreBufferCasResult {
  blob: StorageBlob;
  isDeduplicated: boolean;
}

export interface RegisterUploadedObjectInput {
  storageKey: string;
  sizeBytes: bigint;
  contentHashHex?: string;
}

export interface FileActorContext {
  userId: string;
  spaceId?: string | null;
}

export interface DeleteFileTarget {
  spaceId: string;
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
  blob?: StorageBlob;
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
  blob: StorageBlob;
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
  scope?: string;
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
  blob?: StorageBlob;
}

export interface CompleteFileMultipartInput {
  sessionId: string;
  parts: CompletedPart[];
  actor?: FileActorContext;
}

export interface CompleteFileMultipartOutput {
  blob: StorageBlob;
  session: UploadSession;
  isDeduplicated: boolean;
}

export interface FilesStreamOptions {
  rangeHeader?: string;
  ifNoneMatch?: string;
  mimeType?: string;
  filename?: string;
}

export interface StreamBlobTarget {
  s3Key: StorageBlob['s3Key'] | string;
  sizeBytes: bigint | number;
  contentHash?: StorageBlob['contentHash'];
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
  source?: string;
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

export interface IFilesPort {
  uploadFile(input: UploadFilesInput): Promise<UploadFilesOutput>;
  uploadBuffer(
    key: string,
    buffer: Buffer,
    contentType?: string,
  ): Promise<{ path: string; url: string }>;
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
  deleteFile(fileId: string, target?: DeleteFileTarget): Promise<void>;
  deleteObject(key: string): Promise<void>;
  ensurePdfThumbnail(input: {
    fileId: string;
    userId?: string;
    spaceId?: string | null;
  }): Promise<Buffer | null>;
  storeBuffer(
    buffer: Buffer,
    mimeType: string,
    onBeforeNewUpload?: (sizeBytes: bigint) => Promise<void>,
  ): Promise<StoreBufferCasResult>;
  registerUploadedObject(
    input: RegisterUploadedObjectInput,
  ): Promise<StoreBufferCasResult>;
  presignUpload(
    input: PresignFileUploadInput,
  ): Promise<PresignFileUploadOutput>;
  getPresignedUploadUrl(
    input: PresignFileUploadInput & { scope?: string },
  ): Promise<{
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
  }>;
  completePresignedUpload(
    input: CompletePresignedFileInput,
  ): Promise<CompletePresignedFileOutput>;
  initiateMultipart(
    input: InitiateFileMultipartInput,
  ): Promise<InitiateFileMultipartOutput>;
  initiateMultipartUpload(input: InitiateFileMultipartInput): Promise<{
    sessionId: string;
    uploadId: string;
    partSize: number;
    totalParts: number;
    deduplicated?: boolean;
    fileId?: string;
    url?: string;
    filename?: string;
    size?: number;
  }>;
  presignMultipartPart(
    sessionId: string,
    partNumber: number,
    actor?: FileActorContext,
  ): Promise<{ url: string; partNumber: number }>;
  getMultipartPartUrl(
    sessionId: string,
    partNumber: number,
    actor?: FileActorContext,
  ): Promise<string>;
  completeMultipart(
    input: CompleteFileMultipartInput,
  ): Promise<CompleteFileMultipartOutput>;
  completeMultipartUpload(input: CompleteFileMultipartInput): Promise<{
    fileId: string;
    blobId: string;
    url: string;
    filename: string;
    size: number;
    mimeType: string;
  }>;
  abortMultipart(sessionId: string, actor?: FileActorContext): Promise<void>;
  abortMultipartUpload(
    sessionId: string,
    actor?: FileActorContext,
  ): Promise<void>;
  streamBlob(
    blob: StreamBlobTarget,
    options?: FilesStreamOptions,
  ): Promise<FilesStreamOutput>;
  streamByKey(key: string, rangeHeader?: string): Promise<StreamKeyOutput>;
  getPresignedDownloadUrl(
    fileIdOrKey: string,
    optionsOrExpires?:
      number | { expiresInSeconds?: number; filename?: string },
    userId?: string,
  ): Promise<string>;
  openBlobStream(
    blobId: string,
    range?: { start: number; end: number },
  ): Promise<{
    blob: StorageBlob;
    stream: NodeJS.ReadableStream;
    contentLength: number;
    contentRange?: string;
  }>;
  statObject(key: string): Promise<StorageObjectMetadata>;
  findBlobById(blobId: string): Promise<StorageBlob | null>;
  findBlobByHash(contentHashHex: string): Promise<StorageBlob | null>;
  acquireBlob(blobId: string): Promise<StorageBlob | null>;
  releaseBlob(blobId: string): Promise<void>;
  getThumbnailUrl(blobId: string): string;
  ensureImageThumbnail(input: {
    fileId: string;
    width?: number;
    height?: number;
    quality?: number;
  }): Promise<EnsureImageThumbnailOutput | null>;
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
  objectExists(key: string): Promise<boolean>;
  copyObject(sourceKey: string, destinationKey: string): Promise<void>;
  deleteObjects(keys: string[]): Promise<void>;
  reclaimOrphanBlobs(limit?: number): Promise<number>;
  cleanupExpiredSessions(limit?: number): Promise<number>;
  applyLifecycleRules(config?: StorageLifecycleConfiguration): Promise<void>;
  getQuota(spaceId?: string | null): Promise<StorageQuota | null>;
  assertQuotaAvailable(
    spaceId: string | null | undefined,
    requiredBytes: bigint,
  ): Promise<void>;
  reserveQuota(
    spaceId: string | null | undefined,
    bytes: bigint,
  ): Promise<bigint>;
  releaseQuota(
    spaceId: string | null | undefined,
    bytes: bigint,
  ): Promise<bigint>;
}
