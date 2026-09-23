/**
 * filestore/core/use-cases/upload-manuscript-file.use-case.ts
 * Application Use Case orchestrating Content-Addressable Storage upload with deduplication.
 */

import { Injectable, Logger } from '@nestjs/common';
import { Readable } from 'node:stream';
import { ManuscriptFile } from '../domain/entities/manuscript-file.entity';
import { IBinaryStoragePort } from '../ports/binary-storage.port';
import { IManuscriptFileRepository } from '../ports/manuscript-file-repository.port';
import { IContentHasherPort } from '../ports/content-hasher.port';

export interface UploadManuscriptFileInput {
  projectId: string;
  name: string;
  mimeType?: string;
  stream: Readable;
  bucketName?: string;
}

@Injectable()
export class UploadManuscriptFileUseCase {
  private readonly logger = new Logger(UploadManuscriptFileUseCase.name);

  constructor(
    private readonly storage: IBinaryStoragePort,
    private readonly repository: IManuscriptFileRepository,
    private readonly hasher: IContentHasherPort,
  ) {}

  public async execute(input: UploadManuscriptFileInput): Promise<ManuscriptFile> {
    const bucket = input.bucketName ?? 'manuscript-files';

    // 1. Zero-buffering stream hash (Git-blob format)
    const { contentHash, sizeBytes, dataStream } = await this.hasher.hashStream(input.stream);

    // 2. Compute partitioned storage key
    const storageKey = this.hasher.buildStorageKey(contentHash);

    // 3. Content-Addressable Storage (CAS) Deduplication check
    const blobExists = await this.storage.checkObjectExists(bucket, storageKey.getValue());

    if (blobExists) {
      this.logger.log(
        `[CAS Deduplication] Reusing existing blob '${storageKey.getValue()}' for file '${input.name}' in project '${input.projectId}'. (0 bytes written to storage)`,
      );
    } else {
      // 4. Physical upload to storage driver
      await this.storage.sendStream(bucket, storageKey.getValue(), dataStream, {
        contentType: input.mimeType || 'application/octet-stream',
      });
      this.logger.log(
        `[CAS Write] Stored new blob '${storageKey.getValue()}' (${sizeBytes} bytes) for project '${input.projectId}'.`,
      );
    }

    // 5. Persist metadata in relational database
    const fileEntity = ManuscriptFile.create({
      projectId: input.projectId,
      name: input.name,
      mimeType: input.mimeType || 'application/octet-stream',
      sizeBytes,
      hash: contentHash,
      storageKey,
      bucketName: bucket,
    });

    return await this.repository.save(fileEntity);
  }
}
