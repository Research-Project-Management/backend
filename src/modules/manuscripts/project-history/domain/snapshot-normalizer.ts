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
} from './file-snapshot.vo';

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
   * Normalizes any of the 3 database snapshot `files` JSON shapes into a canonical `Map<string, FileSnapshotVo>`:
   *   1. Structured `Record<string, FileSnapshotProps>` (`{ path, type, hash, sizeBytes, lines, ... }`)
   *   2. Variant structured `Record<string, FileSnapshotVoProps>` (`{ path, type, contentHash, sizeInBytes, textContent }`)
   *   3. Legacy/Bridge `Record<string, string>` (where values are raw file text strings and `__` keys are metadata)
   */
  public static parseSnapshotFiles(
    rawFiles: unknown,
  ): Map<string, FileSnapshotVo> {
    const filesMap = new Map<string, FileSnapshotVo>();

    if (!rawFiles || typeof rawFiles !== 'object' || Array.isArray(rawFiles)) {
      return filesMap;
    }

    const entries = rawFiles as Record<string, unknown>;

    const legacyDocIdsByPath = new Map<string, string>();
    for (const [key, val] of Object.entries(entries)) {
      if (key.startsWith('__doc_id__:')) {
        const targetPath = key.slice('__doc_id__:'.length);
        if (typeof val === 'string' && targetPath) {
          const normalized = targetPath.startsWith('/')
            ? targetPath
            : `/${targetPath}`;
          legacyDocIdsByPath.set(normalized, val);
        }
      }
    }

    for (const [rawKey, rawVal] of Object.entries(entries)) {
      if (rawKey.startsWith('__')) {
        continue;
      }

      const normalizedPath = rawKey.startsWith('/') ? rawKey : `/${rawKey}`;

      if (typeof rawVal === 'string') {
        const lines = rawVal.split('\n');
        const hash = crypto.createHash('sha256').update(rawVal).digest('hex');
        const sizeBytes = Buffer.byteLength(rawVal, 'utf8');
        const docId = legacyDocIdsByPath.get(normalizedPath) ?? null;
        const isRootDoc = normalizedPath === '/main.tex' || filesMap.size === 0;

        filesMap.set(
          normalizedPath,
          FileSnapshotVo.fromProps({
            path: normalizedPath,
            type: 'doc',
            docId,
            hash,
            sizeBytes,
            lines,
            isRootDoc,
          }),
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

        let lines: string[] | null = null;
        let rawText: string | null = null;

        if (Array.isArray(obj.lines)) {
          lines = obj.lines.map((l) => String(l ?? ''));
          rawText = lines.join('\n');
        } else if (typeof obj.textContent === 'string') {
          rawText = obj.textContent;
          lines = rawText.split('\n');
        } else if (typeof obj.content === 'string') {
          rawText = obj.content;
          lines = rawText.split('\n');
        } else if (type === 'doc') {
          lines = [''];
          rawText = '';
        }

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
          docId: obj.docId ?? legacyDocIdsByPath.get(resolvedPath) ?? null,
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
        FileSnapshotVo.fromProps({
          path: '/main.tex',
          type: 'doc',
          docId: null,
          hash: crypto.createHash('sha256').update('').digest('hex'),
          sizeBytes: 0,
          lines: [''],
          isRootDoc: true,
        }),
      );
    }

    return filesMap;
  }
}
