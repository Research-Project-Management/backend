export interface ReadOwnedFileInput {
  workspaceId: string;
  fileId: string;
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
  workspaceId: string;
  userId: string;
  filename: string;
  buffer: Buffer;
  mimeType: string;
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
  linkFile(input: LinkFileInput): Promise<void>;
  uploadFile(input: UploadFileInput): Promise<UploadFileOutput>;
  uploadBuffer?(
    key: string,
    buffer: Buffer,
    contentType?: string,
  ): Promise<{ path: string; url: string }>;
}

export const STORAGE_PORT = 'STORAGE_PORT';
