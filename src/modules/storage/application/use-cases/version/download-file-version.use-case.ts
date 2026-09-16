import {
  Injectable,
  Inject,
  NotFoundException,
} from '@nestjs/common';
import { Readable } from 'stream';
import {
  STORAGE_DRIVER,
  STORAGE_BLOB_REPOSITORY,
  STORAGE_VERSION_REPOSITORY,
} from '../../../storage.tokens';
import { IStorageDriver } from '../../../domain/ports/storage-driver.port';
import { IStorageBlobRepository } from '../../../domain/ports/storage-blob.repository.port';
import { IStorageVersionRepository } from '../../../domain/ports/storage-version.repository.port';
import { StorageAccessPolicy } from '../../policies/storage-access.policy';

export interface DownloadFileVersionOutput {
  stream: Readable;
  filename: string;
  mimeType: string;
  size: number;
  versionNumber: number;
}

@Injectable()
export class DownloadFileVersionUseCase {
  constructor(
    @Inject(STORAGE_DRIVER) private readonly driver: IStorageDriver,
    @Inject(STORAGE_BLOB_REPOSITORY)
    private readonly blobRepo: IStorageBlobRepository,
    @Inject(STORAGE_VERSION_REPOSITORY)
    private readonly versionRepo: IStorageVersionRepository,
    private readonly accessPolicy: StorageAccessPolicy,
  ) {}

  async execute(
    fileId: string,
    versionNumber: number,
    userId: string,
  ): Promise<DownloadFileVersionOutput> {
    const node = await this.accessPolicy.assertCanAccess(userId, fileId, 'read');

    let blobId: string | null = null;
    const version = await this.versionRepo.findByFileAndVersion(fileId, versionNumber);

    if (version) {
      blobId = version.blobId;
    } else if (versionNumber === 1 && node.blobId) {
      blobId = node.blobId;
    } else {
      throw new NotFoundException(
        `Version ${versionNumber} not found for file ${node.name}`,
      );
    }

    const blob = await this.blobRepo.findById(blobId);
    if (!blob) {
      throw new NotFoundException('Physical data blob not found in storage');
    }

    const { stream } = await this.driver.getStream(blob.s3Key.value());

    // Generate versioned download name e.g. "experiment_v2.csv"
    const dotIndex = node.name.lastIndexOf('.');
    const versionedFilename =
      dotIndex !== -1
        ? `${node.name.slice(0, dotIndex)}_v${versionNumber}${node.name.slice(dotIndex)}`
        : `${node.name}_v${versionNumber}`;

    return {
      stream,
      filename: versionedFilename,
      mimeType: node.mimeType || 'application/octet-stream',
      size: Number(blob.sizeBytes),
      versionNumber,
    };
  }
}
