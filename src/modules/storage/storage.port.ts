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

export interface IStoragePort {
  readOwnedFile(input: ReadOwnedFileInput): Promise<ReadOwnedFileOutput>;
  linkFile?(input: LinkFileInput): Promise<void>;
  uploadBuffer?(
    key: string,
    buffer: Buffer,
    contentType?: string,
  ): Promise<{ path: string; url: string }>;
}

export const STORAGE_PORT = 'STORAGE_PORT';
