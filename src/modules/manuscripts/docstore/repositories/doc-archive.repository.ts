/**
 * modules/manuscripts/docstore/repositories/doc-archive.repository.ts
 * Cold Tier document archive repository seam supporting both in-memory test stand-in
 * and S3/disk persistence (2 adapters = a real seam!).
 */

import { Injectable, Logger, Optional, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Readable } from 'stream';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { IBinaryStoragePort } from '../../filestore/filestore.types';
import {
  IDocPersistor,
  Md5MismatchError,
  ArchiveObjectNotFoundError,
  computeContentMd5,
} from '../domain';

/**
 * Pure in-memory archive repository adapter for fast, deterministic unit tests.
 */
@Injectable()
export class InMemoryDocArchiveRepository implements IDocPersistor {
  private readonly store = new Map<string, { buffer: Buffer; md5: string }>();

  public async sendStream(
    key: string,
    stream: Readable,
    options?: { sourceMd5?: string },
  ): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const buffer = Buffer.concat(chunks);
    const actualMd5 = computeContentMd5(buffer);

    if (options?.sourceMd5 && options.sourceMd5 !== actualMd5) {
      throw new Md5MismatchError('MD5 mismatch when storing doc archive', {
        key,
        sourceMd5: options.sourceMd5,
        actualMd5,
      });
    }

    this.store.set(key, { buffer, md5: actualMd5 });
  }

  public async getObjectStream(key: string): Promise<Readable> {
    const item = this.store.get(key);
    if (!item) {
      throw new ArchiveObjectNotFoundError(key);
    }
    return Readable.from(item.buffer);
  }

  public async getObjectMd5Hash(key: string): Promise<string> {
    const item = this.store.get(key);
    if (!item) {
      throw new ArchiveObjectNotFoundError(key);
    }
    return item.md5;
  }

  public async deleteObject(key: string): Promise<void> {
    this.store.delete(key);
  }

  public isDurableStorageConfigured(): boolean {
    return true;
  }
}

/**
 * Cold Tier document archive repository backed by disk/S3 object storage with in-memory hot cache.
 */
@Injectable()
export class DocArchiveRepository implements IDocPersistor {
  private static readonly MAX_IN_MEMORY_ENTRIES = 500;
  private readonly logger = new Logger(DocArchiveRepository.name);
  private readonly bucket: string;
  private readonly storageDir: string;
  private readonly durableConfigured: boolean;
  private readonly inMemoryStore = new Map<
    string,
    { buffer: Buffer; md5: string }
  >();

  constructor(@Optional() private readonly configService?: ConfigService) {
    const configuredBucket = this.configService?.get<string>('S3_BUCKET_NAME');
    const configuredDurable = this.configService?.get<string>(
      'DOCSTORE_ARCHIVE_DURABLE',
    );
    const configuredDir = this.configService?.get<string>(
      'DOCSTORE_ARCHIVE_DIR',
    );
    this.durableConfigured = Boolean(
      configuredBucket || configuredDurable || configuredDir,
    );
    this.bucket = configuredBucket || 'flux-docstore-archive';
    this.storageDir =
      configuredDir || path.join(os.tmpdir(), 'flux-docstore-archive');
    try {
      fs.mkdirSync(this.storageDir, { recursive: true });
    } catch (err) {
      this.logger.warn(
        `Could not create archive directory ${this.storageDir}: ${err}`,
      );
    }
  }

  public isDurableStorageConfigured(): boolean {
    return this.durableConfigured;
  }

  private setInMemoryItem(
    key: string,
    item: { buffer: Buffer; md5: string },
  ): void {
    if (this.inMemoryStore.has(key)) {
      this.inMemoryStore.delete(key);
    } else if (
      this.inMemoryStore.size >= DocArchiveRepository.MAX_IN_MEMORY_ENTRIES
    ) {
      const oldestKey = this.inMemoryStore.keys().next().value;
      if (oldestKey !== undefined) {
        this.inMemoryStore.delete(oldestKey);
      }
    }
    this.inMemoryStore.set(key, item);
  }

  private resolveDiskPath(key: string): string {
    const safeKey = key.replace(/\.\./g, '_').replace(/^[/\\]+/, '');
    return path.join(this.storageDir, safeKey);
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
    options?: { sourceMd5?: string },
  ): Promise<void> {
    const buffer = await this.streamToBuffer(stream);
    const actualMd5 = computeContentMd5(buffer);

    if (options?.sourceMd5 && options.sourceMd5 !== actualMd5) {
      throw new Md5MismatchError('MD5 mismatch when storing doc archive', {
        key,
        sourceMd5: options.sourceMd5,
        actualMd5,
      });
    }

    this.setInMemoryItem(key, { buffer, md5: actualMd5 });
    try {
      const filePath = this.resolveDiskPath(key);
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      await fs.promises.writeFile(filePath, buffer);
    } catch (err) {
      this.logger.warn(`Could not persist archive key ${key} to disk: ${err}`);
    }

    this.logger.debug(
      `Stored cold-tier archive for key ${key} (${buffer.length} bytes, md5: ${actualMd5})`,
    );
  }

  private async loadOrGetItem(
    key: string,
  ): Promise<{ buffer: Buffer; md5: string }> {
    const cached = this.inMemoryStore.get(key);
    if (cached) {
      // Refresh LRU order
      this.inMemoryStore.delete(key);
      this.inMemoryStore.set(key, cached);
      return cached;
    }

    const filePath = this.resolveDiskPath(key);
    try {
      const buffer = await fs.promises.readFile(filePath);
      const md5 = computeContentMd5(buffer);
      const item = { buffer, md5 };
      this.setInMemoryItem(key, item);
      return item;
    } catch {
      throw new ArchiveObjectNotFoundError(key);
    }
  }

  public async getObjectStream(key: string): Promise<Readable> {
    const item = await this.loadOrGetItem(key);
    return Readable.from(item.buffer);
  }

  public async getObjectMd5Hash(key: string): Promise<string> {
    const item = await this.loadOrGetItem(key);
    return item.md5;
  }

  public async deleteObject(key: string): Promise<void> {
    this.inMemoryStore.delete(key);
    const filePath = this.resolveDiskPath(key);
    await fs.promises.unlink(filePath).catch(() => {});
  }
}

/**
 * Cold Tier document archive adapter delegating to IBinaryStoragePort (S3 or local disk)
 * with stream-level MD5 validation and fallback to local disk DocArchiveRepository.
 */
@Injectable()
export class StoragePortDocArchiveAdapter implements IDocPersistor {
  private readonly logger = new Logger(StoragePortDocArchiveAdapter.name);
  private readonly bucket: string;
  private readonly diskFallback: DocArchiveRepository;

  constructor(
    @Optional()
    @Inject(IBinaryStoragePort)
    private readonly binaryStorage?: IBinaryStoragePort,
    @Optional() private readonly configService?: ConfigService,
  ) {
    this.bucket =
      this.configService?.get<string>('S3_BUCKET_NAME') ||
      this.configService?.get<string>('DOCSTORE_ARCHIVE_BUCKET') ||
      'flux-docstore-archive';
    this.diskFallback = new DocArchiveRepository(this.configService);
  }

  public isDurableStorageConfigured(): boolean {
    if (this.binaryStorage) {
      return true;
    }
    return this.diskFallback.isDurableStorageConfigured();
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
    options?: { sourceMd5?: string },
  ): Promise<void> {
    const buffer = await this.streamToBuffer(stream);
    const actualMd5 = computeContentMd5(buffer);

    if (options?.sourceMd5 && options.sourceMd5 !== actualMd5) {
      throw new Md5MismatchError('MD5 mismatch when storing doc archive', {
        key,
        sourceMd5: options.sourceMd5,
        actualMd5,
      });
    }

    if (this.binaryStorage) {
      try {
        await this.binaryStorage.sendStream(
          this.bucket,
          key,
          Readable.from(buffer),
          {
            sourceMd5: actualMd5,
            contentType: 'application/json',
          },
        );
        this.logger.debug(
          `Persisted doc archive key "${key}" (${buffer.length} bytes, md5: ${actualMd5}) via IBinaryStoragePort`,
        );
        return;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `IBinaryStoragePort upload failed for "${key}", falling back to disk archive: ${msg}`,
        );
      }
    }

    await this.diskFallback.sendStream(key, Readable.from(buffer), {
      sourceMd5: actualMd5,
    });
  }

  public async getObjectStream(key: string): Promise<Readable> {
    if (this.binaryStorage) {
      try {
        const exists = await this.binaryStorage.checkObjectExists(
          this.bucket,
          key,
        );
        if (exists) {
          return await this.binaryStorage.getObjectStream(this.bucket, key);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.debug(
          `IBinaryStoragePort check failed for key "${key}": ${msg}`,
        );
      }
    }

    return await this.diskFallback.getObjectStream(key);
  }

  public async getObjectMd5Hash(key: string): Promise<string> {
    if (this.binaryStorage) {
      try {
        const exists = await this.binaryStorage.checkObjectExists(
          this.bucket,
          key,
        );
        if (exists) {
          const meta = await this.binaryStorage.getObjectMetadata(
            this.bucket,
            key,
          );
          if (meta?.etag) {
            return meta.etag.replace(/"/g, '');
          }
          const stream = await this.binaryStorage.getObjectStream(
            this.bucket,
            key,
          );
          const buffer = await this.streamToBuffer(stream);
          return computeContentMd5(buffer);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.debug(
          `IBinaryStoragePort getObjectMd5Hash failed for key "${key}": ${msg}`,
        );
      }
    }

    return await this.diskFallback.getObjectMd5Hash(key);
  }

  public async deleteObject(key: string): Promise<void> {
    if (this.binaryStorage) {
      try {
        await this.binaryStorage.deleteObject(this.bucket, key);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.debug(
          `IBinaryStoragePort deleteObject notice for key "${key}": ${msg}`,
        );
      }
    }

    await this.diskFallback.deleteObject(key);
  }
}

export { IDocPersistor } from '../domain';
