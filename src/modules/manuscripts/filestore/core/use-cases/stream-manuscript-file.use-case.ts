/**
 * filestore/core/use-cases/stream-manuscript-file.use-case.ts
 * Application Use Case for streaming binary content with byte-range slicing (RFC 7233).
 */

import { Injectable } from '@nestjs/common';
import { Readable } from 'node:stream';
import { ManuscriptFile } from '@/modules/manuscripts/filestore/core/domain/entities/manuscript-file.entity';
import { ByteRange } from '@/modules/manuscripts/filestore/core/domain/value-objects/byte-range.vo';
import { FileNotFoundException } from '@/modules/manuscripts/filestore/core/domain/exceptions/file-not-found.exception';
import { IBinaryStoragePort } from '@/modules/manuscripts/filestore/core/ports/binary-storage.port';
import { IManuscriptFileRepository } from '@/modules/manuscripts/filestore/core/ports/manuscript-file-repository.port';

export interface StreamManuscriptFileInput {
  projectId: string;
  fileId: string;
  rangeHeader?: string;
}

export interface StreamManuscriptFileOutput {
  file: ManuscriptFile;
  stream: Readable;
  byteRange: ByteRange | null;
  isPartialContent: boolean;
  contentLength: number;
}

@Injectable()
export class StreamManuscriptFileUseCase {
  constructor(
    private readonly storage: IBinaryStoragePort,
    private readonly repository: IManuscriptFileRepository,
  ) {}

  public async execute(
    input: StreamManuscriptFileInput,
  ): Promise<StreamManuscriptFileOutput> {
    const file = await this.repository.findByProjectAndId(
      input.projectId,
      input.fileId,
    );
    if (!file || file.deleted) {
      throw new FileNotFoundException(input.fileId, input.projectId);
    }

    // Parse byte range if present
    const byteRange = ByteRange.parse(input.rangeHeader, file.sizeBytes);

    const rangeOpts = byteRange
      ? { start: byteRange.start, end: byteRange.end }
      : undefined;
    const stream = await this.storage.getObjectStream(
      file.bucketName,
      file.storageKey.getValue(),
      rangeOpts,
    );

    const isPartialContent = byteRange !== null;
    const contentLength = byteRange ? byteRange.contentLength : file.sizeBytes;

    return {
      file,
      stream,
      byteRange,
      isPartialContent,
      contentLength,
    };
  }
}
