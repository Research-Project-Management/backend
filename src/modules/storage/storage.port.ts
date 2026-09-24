import { STORAGE_PORT } from './storage.tokens';

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

export function getFileContentPath(fileId: string): string {
  return `/api/files/${encodeURIComponent(fileId)}/content`;
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
  source?: string;
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

export interface IStoragePort {
  readOwnedFile(input: ReadOwnedFileInput): Promise<ReadOwnedFileOutput>;
  getOwnedFileStream?(input: ReadOwnedFileInput & {
    range?: { start: number; end: number };
  }): Promise<{
    stream: NodeJS.ReadableStream;
    mimeType: string;
    size: number;
    filename: string;
    contentRange?: string;
  }>;
  linkFile(input: LinkFileInput): Promise<void>;
  uploadFile(input: UploadFileInput): Promise<UploadFileOutput>;
  deleteFile?(fileId: string): Promise<void>;
  uploadBuffer?(
    key: string,
    buffer: Buffer,
    contentType?: string,
  ): Promise<{ path: string; url: string }>;
  getFileStream?(
    fileId: string,
    range?: { start: number; end: number },
  ): Promise<{
    stream: NodeJS.ReadableStream;
    mimeType: string;
    size: number;
    filename: string;
    contentRange?: string;
  }>;
  getPresignedDownloadUrl?(
    fileId: string,
    expiresInSeconds?: number,
  ): Promise<string>;
  getPresignedUploadUrl?(input: {
    userId: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    contentHash?: string;
    projectId?: string | null;
    parentId?: string | null;
    scope?: any;
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
  completePresignedUpload?(input: {
    userId: string;
    storageKey: string;
    filename: string;
    sizeBytes?: number;
    mimeType?: string;
    projectId?: string | null;
    parentId?: string | null;
    scope?: any;
    contentHash?: string;
  }): Promise<{
    fileId: string;
    blobId: string;
    url: string;
    filename: string;
    size: number;
    mimeType: string;
  }>;
  initiateMultipartUpload?(input: {
    userId: string;
    filename: string;
    mimeType: string;
    totalSize: number;
    projectId?: string | null;
    parentId?: string | null;
    scope?: any;
    expectedHash?: string;
  }): Promise<{
    sessionId: string;
    uploadId: string;
    partSize: number;
    totalParts: number;
  }>;
  getMultipartPartUrl?(sessionId: string, partNumber: number): Promise<string>;
  completeMultipartUpload?(input: {
    sessionId: string;
    parts: { partNumber: number; eTag: string }[];
  }): Promise<{
    fileId: string;
    blobId: string;
    url: string;
    filename: string;
    size: number;
  }>;
  abortMultipartUpload?(sessionId: string): Promise<void>;
  checkQuota?(
    userId?: string | null,
    projectId?: string | null,
  ): Promise<{ usedBytes: number; maxBytes: number; percentage: number }>;
}

export { STORAGE_PORT };
