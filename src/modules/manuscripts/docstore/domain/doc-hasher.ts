/**
 * modules/manuscripts/docstore/domain/doc-hasher.ts
 * Pure in-process cryptographic hashing functions for document lines and buffers.
 */

import * as crypto from 'crypto';

/**
 * Computes a SHA-256 hex digest over a document's lines array joined by LF (`\n`).
 */
export function computeDocSha256(lines: readonly string[]): string {
  const raw = lines.join('\n');
  return crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
}

/**
 * Computes an MD5 hex digest over raw string or Buffer content (e.g., cold-storage archive verification).
 */
export function computeContentMd5(content: string | Buffer): string {
  return crypto.createHash('md5').update(content).digest('hex');
}

/**
 * Pure domain object grouping document hashing computations.
 */
export const DocHasher = {
  computeHash: computeDocSha256,
  computeMd5: computeContentMd5,
} as const;
