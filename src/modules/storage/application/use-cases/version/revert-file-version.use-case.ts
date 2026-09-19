import {
  Injectable,
  Inject,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as crypto from 'crypto';
import {
  STORAGE_NODE_REPOSITORY,
  STORAGE_BLOB_REPOSITORY,
  STORAGE_VERSION_REPOSITORY,
} from '../../../storage.tokens';
import { IStorageNodeRepository } from '../../../domain/ports/storage-node.repository.port';
import { IStorageBlobRepository } from '../../../domain/ports/storage-blob.repository.port';
import { IStorageVersionRepository } from '../../../domain/ports/storage-version.repository.port';
import { StorageAccessPolicy } from '../../policies/storage-access.policy';
import { StorageRedisCacheService } from '../../../infrastructure/cache/storage-redis-cache.service';
import { StorageVersion } from '../../../domain/entities/storage-version.entity';
import { FileUploadedEvent } from '../../../domain/events/file-uploaded.event';

export interface RevertFileVersionOutput {
  fileId: string;
  revertedToVersion: number;
  newVersionNumber: number;
  blobId: string;
  size: number;
}

@Injectable()
export class RevertFileVersionUseCase {
  constructor(
    @Inject(STORAGE_NODE_REPOSITORY)
    private readonly nodeRepo: IStorageNodeRepository,
    @Inject(STORAGE_BLOB_REPOSITORY)
    private readonly blobRepo: IStorageBlobRepository,
    @Inject(STORAGE_VERSION_REPOSITORY)
    private readonly versionRepo: IStorageVersionRepository,
    private readonly accessPolicy: StorageAccessPolicy,
    private readonly cache: StorageRedisCacheService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async execute(
    fileId: string,
    versionNumber: number,
    userId: string,
  ): Promise<RevertFileVersionOutput> {
    const node = await this.accessPolicy.assertCanAccess(
      userId,
      fileId,
      'write',
    );

    if (node.isFolder) {
      throw new BadRequestException('Cannot revert a folder');
    }

    const targetVersion = await this.versionRepo.findByFileAndVersion(
      fileId,
      versionNumber,
    );

    if (!targetVersion) {
      throw new NotFoundException(
        `Version ${versionNumber} not found for file ${node.name}`,
      );
    }

    const blob = await this.blobRepo.findById(targetVersion.blobId);
    if (!blob) {
      throw new NotFoundException(
        'Data blob for target version does not exist',
      );
    }

    // 1. Calculate new version number
    const latestVer = await this.versionRepo.getLatestVersionNumber(fileId);
    const newVersionNumber = latestVer + 1;

    // 2. Increment blob ref count (since new version references it)
    blob.incrementRef();
    await this.blobRepo.update(blob);

    // 3. Create new audit version record
    await this.versionRepo.create(
      new StorageVersion({
        id: crypto.randomUUID(),
        fileId: node.id,
        blobId: targetVersion.blobId,
        versionNumber: newVersionNumber,
        changeComment: `Khôi phục về Phiên bản ${versionNumber} (Reverted to v${versionNumber})`,
        createdById: userId,
        createdAt: new Date(),
        sizeBytes: blob.sizeBytes,
        mimeType: node.mimeType,
      }),
    );

    // 4. Update active StorageNode
    node.updateBlob(targetVersion.blobId, blob.sizeBytes, node.mimeType);
    await this.nodeRepo.update(node);

    // 5. Invalidate cache
    const scopeKey = node.projectId ?? node.authorId;
    await this.cache.invalidateFolder(scopeKey, node.parentId);

    // 6. Notify AI RAG
    this.eventEmitter.emit(
      'file.uploaded',
      new FileUploadedEvent(
        node.id,
        targetVersion.blobId,
        userId,
        node.name,
        node.mimeType,
        blob.sizeBytes,
        blob.s3Key.value(),
        node.projectId,
      ),
    );

    return {
      fileId: node.id,
      revertedToVersion: versionNumber,
      newVersionNumber,
      blobId: targetVersion.blobId,
      size: Number(blob.sizeBytes),
    };
  }
}
