/**
 * modules/manuscripts/docstore/core/adapters/engine/doc-hasher.adapter.ts
 * Backward-compatible adapter delegating to pure domain functions in domain/doc-hasher.
 */

import { IDocHasher } from '@/modules/manuscripts/docstore/core/ports/doc-hasher.port';
import {
  computeDocSha256,
  computeContentMd5,
} from '@/modules/manuscripts/docstore/domain/doc-hasher';

export class DocHasherAdapter implements IDocHasher {
  public computeHash(lines: string[]): string {
    return computeDocSha256(lines);
  }

  public computeMd5(content: string | Buffer): string {
    return computeContentMd5(content);
  }
}

export {
  computeDocSha256,
  computeContentMd5,
} from '@/modules/manuscripts/docstore/domain/doc-hasher';
