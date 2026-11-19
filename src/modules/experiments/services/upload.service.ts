import {
  Injectable,
  Inject,
  Logger,
  BadRequestException,
  Optional,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as crypto from 'crypto';
import { FILES_PORT, type IFilesPort } from '@/modules/files';
import { EXPERIMENT_NODE_REPOSITORY } from '../experiments.constant';
import {
  CompletePresignInput,
  CompletePresignOutput,
  getFileContentPath,
  PresignUploadInput,
  PresignUploadOutput,
  UploadDirectInput,
  UploadDirectOutput,
} from '../experiments.type';
import { INodeRepository } from '../repositories/node.repository';
import { FileScope, ExperimentNode } from '../domain/node.domain';
import { FileUploadedEvent } from '../domain/experiments.event';
import { ExperimentsCacheService } from './cache.service';

export type {
  UploadDirectInput,
  UploadDirectOutput,
  PresignUploadInput,
  PresignUploadOutput,
  CompletePresignInput,
  CompletePresignOutput,
};

@Injectable()
export class UploadService {
  private readonly logger = new Logger(UploadService.name);

  constructor(
    @Inject(FILES_PORT)
    private readonly filesPort: IFilesPort,
    @Inject(EXPERIMENT_NODE_REPOSITORY)
    private readonly nodeRepo: INodeRepository,
    @Optional()
    private readonly cache?: ExperimentsCacheService,
    @Optional()
    private readonly eventEmitter?: EventEmitter2,
  ) {}

  private resolveScopeAndMetadata(input: {
    scope?: FileScope;
    linkedToType?: string;
    linkedToId?: string | null;
    projectId?: string | null;
    source?: string;
    metaData?: Record<string, unknown> | null;
  }) {
    const resolvedScope =
      input.scope ??
      (input.linkedToType as FileScope | undefined) ??
      (input.projectId ? FileScope.Project : FileScope.Personal);
    const resolvedLinkedId = input.linkedToId ?? input.projectId ?? null;
    const metadata: Record<string, unknown> = {
      ...(input.metaData || {}),
      ...(input.source ? { source: input.source } : {}),
    };
    return { resolvedScope, resolvedLinkedId, metadata };
  }

  private async invalidateAndEmitUpload(params: {
    fileId: string;
    blobId: string;
    userId: string;
    filename: string;
    mimeType: string;
    sizeBytes: bigint;
    storageKey: string;
    projectId?: string | null;
    parentId?: string | null;
  }): Promise<void> {
    const scopeKey = params.projectId ?? params.userId;
    if (this.cache) {
      await this.cache.invalidateFolder(scopeKey, params.parentId ?? null);
      await this.cache.invalidateScopeTree(scopeKey);
    }

    this.eventEmitter?.emit(
      'file.uploaded',
      new FileUploadedEvent(
        params.fileId,
        params.blobId,
        params.userId,
        params.filename,
        params.mimeType,
        params.sizeBytes,
        params.storageKey,
        params.projectId,
      ),
    );
  }

  async upload(input: UploadDirectInput): Promise<UploadDirectOutput> {
    if (input.buffer.length <= 0) {
      throw new BadRequestException('Cannot upload an empty file');
    }

    const uploaded = await this.filesPort.uploadFile({
      userId: input.userId,
      spaceId: input.projectId ?? input.userId,
      filename: input.filename,
      buffer: input.buffer,
      mimeType: input.mimeType,
      source: input.source,
    });

    const sizeBytes = BigInt(uploaded.size);
    const fileId = crypto.randomUUID();
    const { resolvedScope, resolvedLinkedId, metadata } =
      this.resolveScopeAndMetadata(input);
    const node = new ExperimentNode({
      id: fileId,
      projectId: input.projectId ?? null,
      linkedToId: resolvedLinkedId,
      parentId: input.parentId ?? null,
      name: uploaded.filename,
      isFolder: false,
      size: sizeBytes,
      mimeType: uploaded.mimeType,
      blobId: uploaded.blobId,
      scope: resolvedScope,
      metadata,
      authorId: input.userId,
    });
    await this.nodeRepo.create(node);

    await this.invalidateAndEmitUpload({
      fileId,
      blobId: uploaded.blobId,
      userId: input.userId,
      filename: uploaded.filename,
      mimeType: uploaded.mimeType,
      sizeBytes,
      storageKey: uploaded.path,
      projectId: input.projectId,
      parentId: input.parentId,
    });

    return {
      fileId,
      blobId: uploaded.blobId,
      url: getFileContentPath(fileId),
      filename: uploaded.filename,
      size: uploaded.size,
      mimeType: uploaded.mimeType,
      isDeduplicated: uploaded.isDeduplicated,
    };
  }

  async presign(input: PresignUploadInput): Promise<PresignUploadOutput> {
    const res = await this.filesPort.presignUpload({
      userId: input.userId,
      spaceId: input.projectId ?? input.userId,
      filename: input.filename,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      contentHash: input.contentHash,
    });

    if (res.deduplicated && res.blob) {
      const fileId = crypto.randomUUID();
      const { resolvedScope, resolvedLinkedId, metadata } =
        this.resolveScopeAndMetadata(input);
      const node = new ExperimentNode({
        id: fileId,
        projectId: input.projectId ?? null,
        linkedToId: resolvedLinkedId,
        parentId: input.parentId ?? null,
        name: res.cleanFilename,
        isFolder: false,
        size: res.blob.sizeBytes,
        mimeType: input.mimeType,
        blobId: res.blob.id,
        scope: resolvedScope,
        metadata,
        authorId: input.userId,
      });
      await this.nodeRepo.create(node);

      await this.invalidateAndEmitUpload({
        fileId,
        blobId: res.blob.id,
        userId: input.userId,
        filename: res.cleanFilename,
        mimeType: input.mimeType,
        sizeBytes: res.blob.sizeBytes,
        storageKey: res.storageKey,
        projectId: input.projectId,
        parentId: input.parentId,
      });

      return {
        deduplicated: true,
        uploadUrl: '',
        storageKey: res.storageKey,
        fileUuid: res.blob.id,
        expiresIn: 0,
        fileId,
        url: getFileContentPath(fileId),
        filename: res.cleanFilename,
        size: Number(res.blob.sizeBytes),
        mimeType: input.mimeType,
      };
    }

    return {
      deduplicated: false,
      uploadUrl: res.uploadUrl || '',
      storageKey: res.storageKey,
      fileUuid: res.fileUuid || '',
      expiresIn: res.expiresIn,
    };
  }

  async complete(input: CompletePresignInput): Promise<CompletePresignOutput> {
    const completed = await this.filesPort.completePresignedUpload({
      userId: input.userId,
      spaceId: input.projectId ?? input.userId,
      storageKey: input.storageKey,
      filename: input.filename,
      sizeBytes: input.sizeBytes,
      mimeType: input.mimeType,
      contentHash: input.contentHash,
    });

    const fileId = crypto.randomUUID();
    const { resolvedScope, resolvedLinkedId, metadata } =
      this.resolveScopeAndMetadata(input);
    const node = new ExperimentNode({
      id: fileId,
      projectId: input.projectId ?? null,
      linkedToId: resolvedLinkedId,
      parentId: input.parentId ?? null,
      name: completed.cleanFilename,
      isFolder: false,
      size: completed.sizeBytes,
      mimeType: completed.mimeType,
      blobId: completed.blobId,
      scope: resolvedScope,
      metadata,
      authorId: input.userId,
    });
    await this.nodeRepo.create(node);

    await this.invalidateAndEmitUpload({
      fileId,
      blobId: completed.blobId,
      userId: input.userId,
      filename: completed.cleanFilename,
      mimeType: completed.mimeType,
      sizeBytes: completed.sizeBytes,
      storageKey: completed.blob.s3Key.value(),
      projectId: input.projectId,
      parentId: input.parentId,
    });

    return {
      fileId,
      blobId: completed.blobId,
      url: getFileContentPath(fileId),
      filename: completed.cleanFilename,
      size: completed.size,
      mimeType: completed.mimeType,
    };
  }
}
