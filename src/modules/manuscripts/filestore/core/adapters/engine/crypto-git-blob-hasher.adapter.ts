/**
 * filestore/core/adapters/engine/crypto-git-blob-hasher.adapter.ts
 * Driven Adapter implementing IContentHasherPort using Node.js crypto streams.
 * Complies with Git blob CAS hashing format: "blob ${sizeBytes}\0${data}"
 */

import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Readable, PassThrough } from 'node:stream';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { IContentHasherPort, StreamHashResult } from '../../ports/content-hasher.port';
import { ContentHash } from '../../domain/value-objects/content-hash.vo';
import { StorageKey } from '../../domain/value-objects/storage-key.vo';

@Injectable()
export class CryptoGitBlobHasherAdapter extends IContentHasherPort {
  public async hashStream(stream: Readable): Promise<StreamHashResult> {
    // Spool stream to a temporary file to simultaneously measure exact byte length,
    // compute SHA-256, and preserve stream for subsequent S3/Disk storage upload.
    const tempDir = path.join(os.tmpdir(), 'flux-filestore-spool');
    await fs.promises.mkdir(tempDir, { recursive: true });
    const tempFilePath = path.join(tempDir, `spool-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);

    const writeStream = fs.createWriteStream(tempFilePath);
    let sizeBytes = 0;

    const meterStream = new PassThrough();
    meterStream.on('data', (chunk: Buffer | string) => {
      sizeBytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
    });

    await pipeline(stream, meterStream, writeStream);

    // Compute Git-blob hash: "blob " + sizeBytes + "\0" + fileContent
    const gitHeader = Buffer.from(`blob ${sizeBytes}\0`, 'utf8');

    const gitHashObj = createHash('sha1');
    gitHashObj.update(gitHeader);

    const sha256Obj = createHash('sha256');

    // Stream the temp file into hash calculators
    const readStreamForHashing = fs.createReadStream(tempFilePath);
    await new Promise<void>((resolve, reject) => {
      readStreamForHashing.on('data', (chunk: Buffer | string) => {
        gitHashObj.update(chunk);
        sha256Obj.update(chunk);
      });
      readStreamForHashing.on('end', () => resolve());
      readStreamForHashing.on('error', reject);
    });

    const gitBlobHash = gitHashObj.digest('hex');
    const sha256Hex = sha256Obj.digest('hex');

    // Return a self-cleaning readable stream for the consumer
    const replayStream = fs.createReadStream(tempFilePath);
    replayStream.on('close', () => {
      fs.promises.unlink(tempFilePath).catch(() => {});
    });

    return {
      contentHash: ContentHash.create(gitBlobHash),
      sha256Hex,
      sizeBytes,
      dataStream: replayStream,
    };
  }

  public hashBuffer(buffer: Buffer): StreamHashResult {
    const sizeBytes = buffer.length;
    const gitHeader = Buffer.from(`blob ${sizeBytes}\0`, 'utf8');

    const gitHashObj = createHash('sha1');
    gitHashObj.update(gitHeader);
    gitHashObj.update(buffer);
    const gitBlobHash = gitHashObj.digest('hex');

    const sha256Obj = createHash('sha256');
    sha256Obj.update(buffer);
    const sha256Hex = sha256Obj.digest('hex');

    const dataStream = Readable.from(buffer);

    return {
      contentHash: ContentHash.create(gitBlobHash),
      sha256Hex,
      sizeBytes,
      dataStream,
    };
  }

  public buildStorageKey(hash: ContentHash, prefix = 'blobs'): StorageKey {
    return StorageKey.fromHash(hash, prefix);
  }
}
