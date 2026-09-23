/**
 * filestore/core/use-cases/get-signed-download-url.use-case.ts
 * Application Use Case for generating pre-signed direct download URLs.
 */

import { Injectable } from '@nestjs/common';
import { FileNotFoundException } from '../domain/exceptions/file-not-found.exception';
import { IBinaryStoragePort } from '../ports/binary-storage.port';
import { IManuscriptFileRepository } from '../ports/manuscript-file-repository.port';

export interface GetSignedUrlInput {
  projectId: string;
  fileId: string;
  expiresInSeconds?: number;
}

@Injectable()
export class GetSignedDownloadUrlUseCase {
  constructor(
    private readonly storage: IBinaryStoragePort,
    private readonly repository: IManuscriptFileRepository,
  ) {}

  public async execute(input: GetSignedUrlInput): Promise<string | null> {
    const file = await this.repository.findByProjectAndId(input.projectId, input.fileId);
    if (!file || file.deleted) {
      throw new FileNotFoundException(input.fileId, input.projectId);
    }

    const ttl = input.expiresInSeconds ?? 3600;
    return await this.storage.getSignedDownloadUrl(file.bucketName, file.storageKey.getValue(), ttl);
  }
}
