/**
 * filestore/core/use-cases/get-manuscript-file-head.use-case.ts
 * Application Use Case for fast metadata and header retrieval without payload download.
 */

import { Injectable } from '@nestjs/common';
import { ManuscriptFile } from '@/modules/manuscripts/filestore/core/domain/entities/manuscript-file.entity';
import { FileNotFoundException } from '@/modules/manuscripts/filestore/core/domain/exceptions/file-not-found.exception';
import {
  IBinaryStoragePort,
  StorageObjectMetadata,
} from '@/modules/manuscripts/filestore/core/ports/binary-storage.port';
import { IManuscriptFileRepository } from '@/modules/manuscripts/filestore/core/ports/manuscript-file-repository.port';

export interface GetFileHeadInput {
  projectId: string;
  fileId: string;
}

export interface GetFileHeadOutput {
  file: ManuscriptFile;
  storageMetadata?: StorageObjectMetadata;
}

@Injectable()
export class GetManuscriptFileHeadUseCase {
  constructor(
    private readonly storage: IBinaryStoragePort,
    private readonly repository: IManuscriptFileRepository,
  ) {}

  public async execute(input: GetFileHeadInput): Promise<GetFileHeadOutput> {
    const file = await this.repository.findByProjectAndId(
      input.projectId,
      input.fileId,
    );
    if (!file || file.deleted) {
      throw new FileNotFoundException(input.fileId, input.projectId);
    }

    let storageMetadata: StorageObjectMetadata | undefined;
    try {
      storageMetadata = await this.storage.getObjectMetadata(
        file.bucketName,
        file.storageKey.getValue(),
      );
    } catch {
      // Storage metadata optional; file entity sizeBytes is authoritative
    }

    return { file, storageMetadata };
  }
}
