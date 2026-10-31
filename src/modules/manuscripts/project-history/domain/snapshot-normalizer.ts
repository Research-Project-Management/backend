/**
 * project-history/domain/snapshot-normalizer.ts
 * Pure, side-effect-free normalizer transforming any of the 3 database snapshot
 * `files` JSON shapes into a canonical `Map<string, FileSnapshotVo>`.
 */

import * as crypto from 'node:crypto';
import {
  FileSnapshotVo,
  FileSnapshotProps,
  FileSnapshotType,
} from './file-snapshot';

export interface RawSnapshotFileEntry {
  path?: string;
  type?: FileSnapshotType;
  docId?: string | null;
  fileId?: string | null;
  hash?: string;
  contentHash?: string;
  sizeBytes?: number;
  sizeInBytes?: number;
  lines?: string[] | null;
  content?: string | null;
  textContent?: string | null;
  isRootDoc?: boolean;
}

export class SnapshotNormalizer {
  /**
   * Normalizes database snapshot `files` JSON into a canonical `Map<string, FileSnapshotVo>`.
   */
  public static parseSnapshotFiles(
    rawFiles: unknown,
  ): Map<string, FileSnapshotVo> {
    const filesMap = new Map<string, FileSnapshotVo>();

    if (!rawFiles || typeof rawFiles !== 'object' || Array.isArray(rawFiles)) {
      return filesMap;
    }

    const entries = rawFiles as Record<string, unknown>;

    for (const [rawKey, rawVal] of Object.entries(entries)) {
      if (rawKey.startsWith('__')) {
        continue;
      }

      const normalizedPath = rawKey.startsWith('/') ? rawKey : `/${rawKey}`;

      if (typeof rawVal === 'string') {
        filesMap.set(
          normalizedPath,
          FileSnapshotVo.createDoc(
            normalizedPath,
            null,
            rawVal.split('\n'),
            crypto.createHash('sha256').update(rawVal).digest('hex'),
            normalizedPath === '/main.tex' || filesMap.size === 0,
          ),
        );
        continue;
      }

      if (rawVal && typeof rawVal === 'object' && !Array.isArray(rawVal)) {
        const obj = rawVal as RawSnapshotFileEntry;
        const resolvedPath =
          typeof obj.path === 'string' && obj.path.trim()
            ? obj.path.startsWith('/')
              ? obj.path
              : `/${obj.path}`
            : normalizedPath;
        const type: FileSnapshotType = obj.type === 'file' ? 'file' : 'doc';

        const lines = Array.isArray(obj.lines)
          ? obj.lines.map((l) => String(l ?? ''))
          : typeof obj.content === 'string'
            ? obj.content.split('\n')
            : typeof obj.textContent === 'string'
              ? obj.textContent.split('\n')
              : type === 'doc'
                ? ['']
                : null;

        const rawText = lines !== null ? lines.join('\n') : null;

        const hash =
          typeof obj.hash === 'string' && obj.hash
            ? obj.hash
            : typeof obj.contentHash === 'string' && obj.contentHash
              ? obj.contentHash
              : rawText !== null
                ? crypto.createHash('sha256').update(rawText).digest('hex')
                : '';

        const sizeBytes =
          typeof obj.sizeBytes === 'number' && !Number.isNaN(obj.sizeBytes)
            ? obj.sizeBytes
            : typeof obj.sizeInBytes === 'number' &&
                !Number.isNaN(obj.sizeInBytes)
              ? obj.sizeInBytes
              : rawText !== null
                ? Buffer.byteLength(rawText, 'utf8')
                : 0;

        const props: FileSnapshotProps = {
          path: resolvedPath,
          type,
          docId: obj.docId ?? null,
          fileId: obj.fileId ?? null,
          hash,
          sizeBytes,
          lines,
          isRootDoc:
            typeof obj.isRootDoc === 'boolean'
              ? obj.isRootDoc
              : resolvedPath === '/main.tex',
        };

        const vo = FileSnapshotVo.fromProps(props);
        filesMap.set(vo.path, vo);
      }
    }

    if (filesMap.size === 0) {
      filesMap.set(
        '/main.tex',
        FileSnapshotVo.createDoc('/main.tex', null, [''], '', true),
      );
    }

    return filesMap;
  }
}
