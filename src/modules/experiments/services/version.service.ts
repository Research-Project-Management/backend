import {
  Injectable,
  Inject,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Readable } from 'stream';
import * as crypto from 'crypto';
import {
  BlobService,
  sanitizeFilename,
  STORAGE_QUOTA_REPOSITORY,
  validateMagicBytes,
  type IQuotaRepository,
} from '@/modules/files';
import {
  EXPERIMENT_NODE_REPOSITORY,
  EXPERIMENT_VERSION_REPOSITORY,
} from '../experiments.constant';
import { INodeRepository } from '../repositories/node.repository';
import { IVersionRepository } from '../repositories/version.repository';
import { ExperimentsAccessPolicy } from '../domain/access.policy';
import { ExperimentNode } from '../domain/node.domain';
import { ExperimentVersion } from '../domain/version.domain';
import { FileUploadedEvent } from '../domain/experiments.event';
import { ExperimentsCacheService } from './cache.service';

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
    @Inject(EXPERIMENT_NODE_REPOSITORY)
    private readonly nodeRepo: INodeRepository,
    @Inject(STORAGE_QUOTA_REPOSITORY)
    private readonly quotaRepo: IQuotaRepository,
    @Inject(EXPERIMENT_VERSION_REPOSITORY)
    private readonly versionRepo: IVersionRepository,
    private readonly accessPolicy: ExperimentsAccessPolicy,
    private readonly cache: ExperimentsCacheService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async listVersions(
    fileId: string,
    actorId: string,
  ): Promise<GetFileVersionsOutput> {
    const node = await this.nodeRepo.findById(fileId);
    if (!node || node.isTrashed()) {
      throw new NotFoundException('File not found or has been trashed');
    }

    await this.accessPolicy.assertCanAccess(actorId, fileId, 'read');

    const versions = await this.versionRepo.findByFileId(fileId);
    const sorted = [...versions].sort(
      (a, b) => b.versionNumber - a.versionNumber,
    );
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

  async uploadVersion(
    input: UploadNewVersionInput,
  ): Promise<UploadNewVersionOutput> {
    const node = await this.nodeRepo.findById(input.fileId);
    if (!node || node.isTrashed()) {
      throw new NotFoundException('File not found or has been trashed');
    }
    if (node.isFolder) {
      throw new BadRequestException('Cannot version a folder');
    }

    await this.accessPolicy.assertCanAccess(
      input.userId,
      input.fileId,
      'write',
    );

    const cleanFilename = sanitizeFilename(input.filename);
    validateMagicBytes(input.buffer, input.mimeType, cleanFilename);

    const sizeBytes = BigInt(input.buffer.length);
    const { blob, isDeduplicated } = await this.blobService.storeBuffer(
      input.buffer,
      input.mimeType,
      async (bytes) => {
        await this.quotaRepo.incrementUsage(
          node.authorId,
          node.projectId,
          bytes,
        );
      },
    );
    const s3Key = blob.s3Key;

    const latestVersion = await this.versionRepo.getLatestVersionNumber(
      node.id,
    );
    let nextVersionNumber = latestVersion + 1;

    if (latestVersion === 0 && node.blobId) {
      await this.versionRepo.create(
        new ExperimentVersion({
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

    const storageVersion = new ExperimentVersion({
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
    await Promise.resolve(
      this.cache?.invalidateStreamNodeMeta?.(node.id),
    ).catch(() => {});

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

  private async resolveVersionBlob(
    node: ExperimentNode,
    versionNumber: number,
  ): Promise<{ blobId: string; sizeBytes: bigint }> {
    const version = await this.versionRepo.findByFileAndVersion(
      node.id,
      versionNumber,
    );

    if (version) {
      return { blobId: version.blobId, sizeBytes: version.sizeBytes };
    }
    if (versionNumber === 1 && node.blobId) {
      return { blobId: node.blobId, sizeBytes: node.size };
    }

    throw new NotFoundException(
      `Version ${versionNumber} not found for file ${node.name}`,
    );
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

    const { blobId } = await this.resolveVersionBlob(node, versionNumber);
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

    const { blobId: targetBlobId, sizeBytes: targetSize } =
      await this.resolveVersionBlob(node, targetVersionNumber);

    await this.quotaRepo.incrementUsage(
      node.authorId,
      node.projectId,
      targetSize,
    );

    const blob = await this.blobService.incrementBlobRef(targetBlobId);

    const latestVersion = await this.versionRepo.getLatestVersionNumber(
      node.id,
    );
    let newVersionNumber = latestVersion + 1;

    if (latestVersion === 0 && node.blobId) {
      await this.versionRepo.create(
        new ExperimentVersion({
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
      newVersionNumber = 2;
    }

    const newVersion = new ExperimentVersion({
      id: crypto.randomUUID(),
      fileId: node.id,
      versionNumber: newVersionNumber,
      blobId: blob.id,
      sizeBytes: targetSize,
      createdById: actorId,
      changeComment: `Reverted to version ${targetVersionNumber}`,
      createdAt: new Date(),
    });

    await this.versionRepo.create(newVersion);

    node.updateBlob(blob.id, targetSize);
    await this.nodeRepo.update(node);

    const scopeKey = node.projectId ?? node.authorId;
    await this.cache.invalidateFolder(scopeKey, node.parentId);
    await Promise.resolve(
      this.cache?.invalidateStreamNodeMeta?.(node.id),
    ).catch(() => {});

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
