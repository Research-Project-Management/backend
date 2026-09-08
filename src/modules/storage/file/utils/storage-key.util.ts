import { NotFoundException } from '@nestjs/common';

export interface StorageFileLike {
  url?: string | null;
  trashedAt?: Date | null;
  metaData?: unknown;
  isTrash?: boolean;
}

/**
 * Asserts whether a file entity is marked as trashed.
 */
export function assertFileNotTrashed(
  file: StorageFileLike,
  fileId: string,
): void {
  const isTrashed =
    file.trashedAt !== null && file.trashedAt !== undefined
      ? true
      : Boolean((file as Record<string, unknown>).isTrash);

  if (isTrashed) {
    throw new NotFoundException(`File ${fileId} is in trash`);
  }
}

/**
 * Resolves the underlying object key for S3/R2 storage from File metadata and URL.
 */
export function resolveFileStorageKey(
  file: StorageFileLike,
  fileId: string,
): string {
  const R2_PREFIX = '/api/files/r2/';
  let storageKey = '';

  if (file.url && file.url.startsWith(R2_PREFIX)) {
    storageKey = file.url.slice(R2_PREFIX.length).trim();
  } else if (
    file.url &&
    !file.url.startsWith('http') &&
    !file.url.startsWith('/api/files/')
  ) {
    storageKey = file.url.trim();
  } else if (
    file.metaData &&
    typeof file.metaData === 'object' &&
    'storageKey' in (file.metaData as Record<string, unknown>)
  ) {
    const rawKey = (file.metaData as Record<string, unknown>).storageKey;
    if (typeof rawKey === 'string') {
      storageKey = rawKey;
    }
  } else if (file.url) {
    storageKey = file.url.replace(/^\/+/, '');
  }

  if (!storageKey) {
    throw new NotFoundException(
      `Storage object key not found for file ${fileId}`,
    );
  }

  return storageKey;
}
