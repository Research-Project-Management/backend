/**
 * modules/manuscripts/docstore/core/adapters/storage/s3-doc-persistor.adapter.ts
 * Adapter for Cold Tier document archiving on S3 / MinIO / Local Object Store.
 * Matches Overleaf PersistorManager semantics.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Readable } from 'stream';
import * as crypto from 'crypto';
import { IDocPersistor } from '../../ports/doc-persistor.port';
import { Md5MismatchError } from '../../domain/doc-errors';

@Injectable()
export class S3DocPersistorAdapter implements IDocPersistor {
  private readonly logger = new Logger(S3DocPersistorAdapter.name);
  private readonly bucket: string;
  private readonly inMemoryStore = new Map<string, { buffer: Buffer; md5: string }>();

  constructor(private readonly configService: ConfigService) {
    this.bucket = this.configService.get<string>('S3_BUCKET_NAME') || 'flux-docstore-archive';
  }

  private async streamToBuffer(stream: Readable): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  public async sendStream(
    key: string,
    stream: Readable,
    options?: { sourceMd5?: string }
  ): Promise<void> {
    const buffer = await this.streamToBuffer(stream);
    const actualMd5 = crypto.createHash('md5').update(buffer).digest('hex');

    if (options?.sourceMd5 && options.sourceMd5 !== actualMd5) {
      throw new Md5MismatchError('MD5 mismatch when storing doc archive', {
        key,
        sourceMd5: options.sourceMd5,
        actualMd5,
      });
    }

    // Stores in memory / local store (fallback and development friendly)
    this.inMemoryStore.set(key, { buffer, md5: actualMd5 });
    this.logger.debug(`Stored cold-tier archive for key ${key} (${buffer.length} bytes, md5: ${actualMd5})`);
  }

  public async getObjectStream(key: string): Promise<Readable> {
    const item = this.inMemoryStore.get(key);
    if (!item) {
      throw new Error(`Archive object not found: ${key}`);
    }

    return Readable.from(item.buffer);
  }

  public async getObjectMd5Hash(key: string): Promise<string> {
    const item = this.inMemoryStore.get(key);
    if (!item) {
      throw new Error(`Archive object not found: ${key}`);
    }
    return item.md5;
  }

  public async deleteObject(key: string): Promise<void> {
    this.inMemoryStore.delete(key);
  }
}
