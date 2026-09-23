/**
 * modules/manuscripts/docstore/core/ports/doc-hasher.port.ts
 * Contract for content hashing and fingerprinting across docstore and CLSI.
 */

export abstract class IDocHasher {
  abstract computeHash(lines: string[]): string;
  abstract computeMd5(content: string | Buffer): string;
}
