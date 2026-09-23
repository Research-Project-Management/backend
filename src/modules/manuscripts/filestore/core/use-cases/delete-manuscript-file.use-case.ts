/**
 * filestore/core/use-cases/delete-manuscript-file.use-case.ts
 * Application Use Case for deleting a manuscript file record and managing CAS reference counting.
 */

import { Injectable, Logger } from '@nestjs/common';
import { FileNotFoundException } from '../domain/exceptions/file-not-found.exception';
import { IBinaryStoragePort } from '../ports/binary-storage.port';
import { IManuscriptFileRepository } from '../ports/manuscript-file-repository.port';

export interface DeleteManuscriptFileInput {
  projectId: string;
  fileId: string;
  purgePhysicalBlob?: boolean;
}

@Injectable()
export class DeleteManuscriptFileUseCase {
  private readonly logger = new Logger(DeleteManuscriptFileUseCase.name);

  constructor(
    private readonly storage: IBinaryStoragePort,
    private readonly repository: IManuscriptFileRepository,
  ) {}

  public async execute(input: DeleteManuscriptFileInput): Promise<void> {
    const file = await this.repository.findByProjectAndId(input.projectId, input.fileId);
    if (!file || file.deleted) {
      throw new FileNotFoundException(input.fileId, input.projectId);
    }

    // 1. Mark record as deleted in repository
    file.markDeleted();
    await this.repository.save(file);

    // 2. CAS Garbage Collection check (if requested)
    if (input.purgePhysicalBlob) {
      const remainingRefs = await this.repository.countReferencesByHash(file.hash.getValue());
      if (remainingRefs <= 1) {
        // Only this record referenced the blob
        try {
          await this.storage.deleteObject(file.bucketName, file.storageKey.getValue());
          this.logger.log(`[CAS GC] Purged unreferenced physical blob '${file.storageKey.getValue()}'.`);
        } catch (err) {
          this.logger.warn(`[CAS GC] Failed to purge blob '${file.storageKey.getValue()}': ${(err as Error).message}`);
        }
      }
    }
  }
}
