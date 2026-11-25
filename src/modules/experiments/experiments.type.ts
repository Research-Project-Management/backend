import { Readable } from 'node:stream';
import type { CompletedPart } from '@/modules/files';
import { EXPERIMENTS_PORT } from './experiments.constant';
import { FileScope, ExperimentNode } from './domain/node.domain';

export { EXPERIMENTS_PORT };

export function getFileContentPath(fileId: string): string {
  return `/api/v1/experiments/files/${encodeURIComponent(fileId)}/content`;
}

export interface ListExperimentsFilter {
  userId?: string;
  parentId?: string | null;
  scope?: FileScope | string;
  projectId?: string | null;
  linkedToId?: string | null;
  starredOnly?: boolean;
  trashedOnly?: boolean;
  authorId?: string;
  search?: string;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  types?: string[];
  limit?: number;
  offset?: number;
}

export interface SharedNodeItem {
  node: ExperimentNode;
  permission: string;
  sharedAt: Date;
}

export interface ReadOwnedFileInput {
  fileId: string;
  projectId?: string;
  userId?: string;
}

export interface ReadOwnedFileOutput {
  fileId: string;
  filename: string;
  mimeType: string;
  size: number;
  storageKey: string;
  contentUrl: string;
  buffer: Buffer;
}

export interface LinkFileInput {
  fileId: string;
  linkedToType: string;
  linkedToId: string;
}

export interface UploadFileInput {
  userId: string;
  filename: string;
  buffer: Buffer;
  mimeType: string;
  projectId?: string;
  parentId?: string | null;
}

export interface UploadFileOutput {
  fileId: string;
  url: string;
  path: string;
  filename: string;
  size: number;
  mimeType: string;
}

export interface IExperimentsPort {
  readOwnedFile(input: ReadOwnedFileInput): Promise<ReadOwnedFileOutput>;
  assertFileAccess?(
    fileId: string,
    userId?: string,
    projectId?: string | null,
  ): Promise<void>;
  getOwnedFileStream(
    input: ReadOwnedFileInput & {
      range?: { start: number; end: number };
    },
  ): Promise<{
    stream: NodeJS.ReadableStream;
    mimeType: string;
    size: number;
    filename: string;
    contentRange?: string;
  }>;
  linkFile(input: LinkFileInput): Promise<void>;
  uploadFile(input: UploadFileInput): Promise<UploadFileOutput>;
  deleteFile(fileId: string): Promise<void>;
  ensurePdfThumbnail(input: {
    fileId: string;
    userId?: string;
    projectId?: string | null;
  }): Promise<Buffer | null>;
  getPresignedDownloadUrl(
    fileId: string,
    expiresInSeconds?: number,
    userId?: string,
  ): Promise<string>;
  getPresignedUploadUrl(input: {
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
  }>;
  completePresignedUpload(input: {
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
  }>;
  initiateMultipartUpload(input: {
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
    deduplicated?: boolean;
    fileId?: string;
    url?: string;
    filename?: string;
    size?: number;
  }>;
  getMultipartPartUrl(
    sessionId: string,
    partNumber: number,
    actor?: { userId: string; projectId?: string | null },
  ): Promise<string>;
  completeMultipartUpload(input: {
    sessionId: string;
    parts: { partNumber: number; eTag: string }[];
    actor?: { userId: string; projectId?: string | null };
  }): Promise<{
    fileId: string;
    blobId: string;
    url: string;
    filename: string;
    size: number;
  }>;
  abortMultipartUpload(
    sessionId: string,
    actor?: { userId: string; projectId?: string | null },
  ): Promise<void>;
}

export interface UploadDirectInput {
  userId: string;
  filename: string;
  buffer: Buffer;
  mimeType: string;
  projectId?: string | null;
  linkedToId?: string | null;
  linkedToType?: string;
  parentId?: string | null;
  scope?: FileScope;
  metaData?: Record<string, unknown> | null;
}

export interface UploadDirectOutput {
  fileId: string;
  blobId: string;
  url: string;
  filename: string;
  size: number;
  mimeType: string;
  isDeduplicated: boolean;
}

export interface PresignUploadInput {
  userId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  contentHash?: string;
  projectId?: string | null;
  parentId?: string | null;
  scope?: FileScope;
  metaData?: Record<string, unknown> | null;
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

export interface CompletePresignInput {
  userId: string;
  storageKey: string;
  filename: string;
  sizeBytes?: number;
  mimeType?: string;
  projectId?: string | null;
  parentId?: string | null;
  scope?: FileScope;
  contentHash?: string;
  metaData?: Record<string, unknown> | null;
}

export interface CompletePresignOutput {
  fileId: string;
  blobId: string;
  url: string;
  filename: string;
  size: number;
  mimeType: string;
  isDeduplicated?: boolean;
}

export interface StreamBinaryOutput {
  stream: Readable | null;
  statusCode: number;
  mimeType: string;
  contentLength: number;
  contentRange?: string;
  filename: string;
  etag?: string;
}

export interface MultipartActorContext {
  userId: string;
  projectId?: string | null;
}

export interface InitiateMultipartInput {
  userId: string;
  filename: string;
  mimeType: string;
  totalSize: number;
  projectId?: string | null;
  parentId?: string | null;
  scope?: FileScope;
  expectedHash?: string;
}

export interface CompleteMultipartInput {
  sessionId: string;
  parts: CompletedPart[];
  actor?: MultipartActorContext;
}

export interface CompleteMultipartOutput {
  fileId: string;
  blobId: string;
  filename: string;
  size: number;
  mimeType: string;
}

export interface ExperimentsProcessingJobData {
  fileId: string;
  blobId: string;
  s3Key: string;
  mimeType: string;
  filename: string;
  userId: string;
  projectId?: string | null;
}
