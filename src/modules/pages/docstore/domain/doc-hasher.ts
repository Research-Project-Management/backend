/**
 * modules/manuscripts/docstore/domain/doc-hasher.ts
 * Pure in-process cryptographic hashing functions and contracts for document lines and buffers.
 */

import * as crypto from 'crypto';

/**
 * Contract for content hashing and fingerprinting across docstore and CLSI.
 */
export abstract class IDocHasher {
  abstract computeHash(lines: string[]): string;
  abstract computeMd5(content: string | Buffer): string;
}

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
 * Adapter delegating to pure domain functions in domain/doc-hasher.
 */
export class DocHasherAdapter implements IDocHasher {
  public computeHash(lines: string[]): string {
    return computeDocSha256(lines);
  }

  public computeMd5(content: string | Buffer): string {
    return computeContentMd5(content);
  }
}

/**
 * Pure domain object grouping document hashing computations.
 */
export const DocHasher = {
  computeHash: computeDocSha256,
  computeMd5: computeContentMd5,
} as const;
