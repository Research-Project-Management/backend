/**
 * modules/manuscripts/docstore/core/adapters/engine/doc-hasher.adapter.ts
 * Adapter for SHA-256 and MD5 cryptographic fingerprinting.
 */

import * as crypto from 'crypto';
import { IDocHasher } from '../../ports/doc-hasher.port';

export class DocHasherAdapter implements IDocHasher {
  public computeHash(lines: string[]): string {
    const raw = lines.join('\n');
    return crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
  }

  public computeMd5(content: string | Buffer): string {
    return crypto.createHash('md5').update(content).digest('hex');
  }
}
