import {
  Injectable,
  Inject,
  Optional,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Readable } from 'stream';
import {
  STORAGE_NODE_REPOSITORY,
  STORAGE_QUOTA_REPOSITORY,
  STORAGE_VERSION_REPOSITORY,
} from '@/modules/storage/storage.tokens';
import { IStorageNodeRepository } from '../repositories/prisma-node.repository';
import { IStorageQuotaRepository } from '../repositories/prisma-quota.repository';
import { IStorageVersionRepository } from '../repositories/prisma-version.repository';
import { StorageAccessPolicy } from './access.policy';
import {
  StorageRedisCacheService,
  BlobService,
  ContentHash,
  StorageKey,
  StorageBlob,
  BlobStatus,
  FileUploadedEvent,
  validateMagicBytes,
  sanitizeFilename,
} from '@/modules/storage/core';
import { StorageVersion } from '../types';

export interface FileVersionDto {
  id: string;
  versionNumber: number;
  size: number;
  changeComment: string | null;
  createdAt: string;
  isCurrent: boolean;
  author: {
    id: string;
    name: string;
    avatar: string | null;
  } | null;
}

export interface GetFileVersionsOutput {
  fileId: string;
  filename: string;
  currentVersionNumber: number;
  totalVersions: number;
  versions: FileVersionDto[];
}

export interface UploadNewVersionInput {
  fileId: string;
  userId: string;
  buffer: Buffer;
  filename: string;
  mimeType: string;
  changeComment?: string;
}

export interface UploadNewVersionOutput {
  fileId: string;
  versionNumber: number;
  blobId: string;
  size: number;
  filename: string;
  changeComment: string | null;
  createdAt: Date;
  isDeduplicated: boolean;
}

export interface DownloadFileVersionOutput {
  stream: Readable;
  filename: string;
  mimeType: string;
  size: number;
  versionNumber: number;
}

export interface RevertFileVersionOutput {
  fileId: string;
  revertedToVersion: number;
  newVersionNumber: number;
  blobId: string;
  size: number;
}

@Injectable()
export class VersionService {
  constructor(
    private readonly blobService: BlobService,
    @Inject(STORAGE_NODE_REPOSITORY)
    private readonly nodeRepo: IStorageNodeRepository,
    @Inject(STORAGE_QUOTA_REPOSITORY)
    private readonly quotaRepo: IStorageQuotaRepository,
    @Inject(STORAGE_VERSION_REPOSITORY)
    private readonly versionRepo: IStorageVersionRepository,
    private readonly accessPolicy: StorageAccessPolicy,
    private readonly cache: StorageRedisCacheService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async listVersions(fileId: string, actorId: string): Promise<GetFileVersionsOutput> {
    const node = await this.nodeRepo.findById(fileId);
    if (!node || node.isTrashed()) {
      throw new NotFoundException('File not found or has been trashed');
    }

    await this.accessPolicy.assertCanAccess(actorId, fileId, 'read');

    const versions = await this.versionRepo.findByFileId(fileId);
    const sorted = [...versions].sort((a, b) => b.versionNumber - a.versionNumber);
    const maxVersion = sorted.length > 0 ? sorted[0].versionNumber : 1;

    const versionDtos: FileVersionDto[] = sorted.map((v) => ({
      id: v.id,
      versionNumber: v.versionNumber,
      size: Number(v.sizeBytes),
      changeComment: v.changeComment,
      createdAt: v.createdAt.toISOString(),
      isCurrent: v.versionNumber === maxVersion,
      author: {
        id: v.createdById,
        name: v.author?.name || 'Researcher',
        avatar: v.author?.avatar || null,
      },
    }));

    if (versionDtos.length === 0) {
      versionDtos.push({
        id: node.id,
        versionNumber: 1,
        size: Number(node.size),
        changeComment: 'Initial version',
        createdAt: node.createdAt.toISOString(),
        isCurrent: true,
        author: {
          id: node.authorId,
          name: 'Researcher',
          avatar: null,
        },
      });
    }

    return {
      fileId: node.id,
      filename: node.name,
      currentVersionNumber: maxVersion,
      totalVersions: versionDtos.length,
      versions: versionDtos,
    };
  }

  async uploadVersion(input: UploadNewVersionInput): Promise<UploadNewVersionOutput> {
    const node = await this.nodeRepo.findById(input.fileId);
    if (!node || node.isTrashed()) {
      throw new NotFoundException('File not found or has been trashed');
    }
    if (node.isFolder) {
      throw new BadRequestException('Cannot version a folder');
    }

    await this.accessPolicy.assertCanAccess(input.userId, input.fileId, 'write');

    const cleanFilename = sanitizeFilename(input.filename);
    validateMagicBytes(input.buffer, input.mimeType, cleanFilename);

    const sizeBytes = BigInt(input.buffer.length);
    const { blob, isDeduplicated } = await this.blobService.storeBuffer(
      input.buffer,
      input.mimeType,
    );
    const s3Key = blob.s3Key;

    await this.quotaRepo.incrementUsage(
      node.authorId,
      node.projectId,
      sizeBytes,
    );

    const latestVersion = await this.versionRepo.getLatestVersionNumber(node.id);
    let nextVersionNumber = latestVersion + 1;

    if (latestVersion === 0 && node.blobId) {
      await this.versionRepo.create(
        new StorageVersion({
          id: crypto.randomUUID(),
          fileId: node.id,
          blobId: node.blobId,
          versionNumber: 1,
          changeComment: 'Initial version',
          createdById: node.authorId,
          createdAt: node.createdAt,
          sizeBytes: node.size,
          mimeType: node.mimeType,
        }),
      );
      nextVersionNumber = 2;
    }

    const storageVersion = new StorageVersion({
      id: crypto.randomUUID(),
      fileId: node.id,
      versionNumber: nextVersionNumber,
      blobId: blob.id,
      sizeBytes,
      createdById: input.userId,
      changeComment: input.changeComment ?? null,
      createdAt: new Date(),
    });
    await this.versionRepo.create(storageVersion);

    node.updateBlob(blob.id, sizeBytes);
    await this.nodeRepo.update(node);

    const scopeKey = node.projectId ?? node.authorId;
    await this.cache.invalidateFolder(scopeKey, node.parentId);

    this.eventEmitter.emit(
      'file.uploaded',
      new FileUploadedEvent(
        node.id,
        blob.id,
        input.userId,
        cleanFilename,
        input.mimeType,
        sizeBytes,
        s3Key.value(),
        node.projectId,
      ),
    );

    return {
      fileId: node.id,
      versionNumber: nextVersionNumber,
      blobId: blob.id,
      size: Number(sizeBytes),
      filename: cleanFilename,
      changeComment: storageVersion.changeComment,
      createdAt: storageVersion.createdAt,
      isDeduplicated,
    };
  }

  async downloadVersion(
    fileId: string,
    versionNumber: number,
    actorId: string,
  ): Promise<DownloadFileVersionOutput> {
    const node = await this.nodeRepo.findById(fileId);
    if (!node || node.isTrashed()) {
      throw new NotFoundException('File not found or has been trashed');
    }

    await this.accessPolicy.assertCanAccess(actorId, fileId, 'read');

    let blobId: string | null = null;
    const version = await this.versionRepo.findByFileAndVersion(
      fileId,
      versionNumber,
    );

    if (version) {
      blobId = version.blobId;
    } else if (versionNumber === 1 && node.blobId) {
      blobId = node.blobId;
    } else {
      throw new NotFoundException(
        `Version ${versionNumber} not found for file ${node.name}`,
      );
    }

    if (!blobId) {
      throw new NotFoundException('Physical data blob not found in storage');
    }

    const { blob, stream } = await this.blobService.openStream(blobId);

    const lastDotIndex = node.name.lastIndexOf('.');
    const versionedFilename =
      lastDotIndex !== -1
        ? `${node.name.slice(0, lastDotIndex)}_v${versionNumber}${node.name.slice(lastDotIndex)}`
        : `${node.name}_v${versionNumber}`;

    return {
      stream: stream as Readable,
      filename: versionedFilename,
      mimeType: node.mimeType,
      size: Number(blob.sizeBytes),
      versionNumber,
    };
  }

  async revertVersion(
    fileId: string,
    targetVersionNumber: number,
    actorId: string,
  ): Promise<RevertFileVersionOutput> {
    const node = await this.nodeRepo.findById(fileId);
    if (!node || node.isTrashed()) {
      throw new NotFoundException('File not found or has been trashed');
    }

    await this.accessPolicy.assertCanAccess(actorId, fileId, 'write');

    const targetVersion = await this.versionRepo.findByFileAndVersion(
      fileId,
      targetVersionNumber,
    );

    let targetBlobId: string | null = null;
    let targetSize = node.size;

    if (targetVersion) {
      targetBlobId = targetVersion.blobId;
      targetSize = targetVersion.sizeBytes;
    } else if (targetVersionNumber === 1 && node.blobId) {
      targetBlobId = node.blobId;
      targetSize = node.size;
    } else {
      throw new NotFoundException(
        `Version ${targetVersionNumber} not found for file ${node.name}`,
      );
    }

    const blob = await this.blobService.incrementBlobRef(targetBlobId);

    const latestVersion = await this.versionRepo.getLatestVersionNumber(node.id);
    const newVersionNumber = latestVersion + 1;

    const newVersion = new StorageVersion({
      id: crypto.randomUUID(),
      fileId: node.id,
      versionNumber: newVersionNumber,
      blobId: blob.id,
      sizeBytes: targetSize,
      createdById: actorId,
      changeComment: `Reverted to version ${targetVersionNumber} (Khôi phục về Phiên bản ${targetVersionNumber})`,
      createdAt: new Date(),
    });

    await this.versionRepo.create(newVersion);

    node.updateBlob(blob.id, targetSize);
    await this.nodeRepo.update(node);

    const scopeKey = node.projectId ?? node.authorId;
    await this.cache.invalidateFolder(scopeKey, node.parentId);

    this.eventEmitter.emit(
      'file.uploaded',
      new FileUploadedEvent(
        node.id,
        blob.id,
        actorId,
        node.name,
        node.mimeType,
        targetSize,
        blob.s3Key.value(),
        node.projectId,
      ),
    );

    return {
      fileId: node.id,
      revertedToVersion: targetVersionNumber,
      newVersionNumber,
      blobId: blob.id,
      size: Number(targetSize),
    };
  }
}
