export interface ReadOwnedFileInput {
  workspaceId: string;
  fileId: string;
}

export interface ReadOwnedFileOutput {
  fileId: string;
  filename: string;
  mimeType: string;
  size?: number;
  storageKey: string;
  buffer: Buffer;
}

export interface IStoragePort {
  readOwnedFile(input: ReadOwnedFileInput): Promise<ReadOwnedFileOutput>;
}

export const STORAGE_PORT = 'STORAGE_PORT';
