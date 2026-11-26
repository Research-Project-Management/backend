import {
  Injectable,
  Inject,
  Logger,
  BadRequestException,
  Optional,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as crypto from 'crypto';
import { FILES_PORT } from '@/modules/files/files.constant';
import { type FileActorContext, type IFilesPort } from '@/modules/files/types/files.type';
import {
  CompleteMultipartInput,
  CompleteMultipartOutput,
  CompletePresignInput,
  CompletePresignOutput,
  getFileContentPath,
  InitiateMultipartInput,
  MultipartActorContext,
  PresignUploadInput,
  PresignUploadOutput,
  UploadDirectInput,
  UploadDirectOutput,
} from '../experiments.type';
import { NodeRepository } from '../repositories/node.repository';
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
  MultipartActorContext,
  InitiateMultipartInput,
  CompleteMultipartInput,
  CompleteMultipartOutput,
};

@Injectable()
export class UploadService {
  private readonly logger = new Logger(UploadService.name);

  constructor(
    @Inject(FILES_PORT)
    private readonly filesPort: IFilesPort,
    private readonly nodeRepo: NodeRepository,
    @Optional()
    private readonly cache?: ExperimentsCacheService,
    @Optional()
    private readonly eventEmitter?: EventEmitter2,
  ) {}

  private toFileActor(
    actor?: MultipartActorContext,
  ): FileActorContext | undefined {
    if (!actor) return undefined;
    return {
      userId: actor.userId,
      ...(actor.projectId ? { spaceId: actor.projectId } : {}),
    };
  }

  private async persistUploadedNode(params: {
    blobId: string;
    userId: string;
    filename: string;
    mimeType: string;
    sizeBytes: bigint;
    storageKey: string;
    projectId?: string | null;
    parentId?: string | null;
    linkedToType?: string;
    linkedToId?: string | null;
    scope?: FileScope;
    metaData?: Record<string, unknown> | null;
  }): Promise<string> {
    const fileId = crypto.randomUUID();
    const resolvedScope =
      params.scope ??
      (params.linkedToType as FileScope | undefined) ??
      (params.projectId ? FileScope.Project : FileScope.Personal);

    const node = new ExperimentNode({
      id: fileId,
      projectId: params.projectId ?? null,
      linkedToId: params.linkedToId ?? params.projectId ?? null,
      parentId: params.parentId ?? null,
      name: params.filename,
      isFolder: false,
      size: params.sizeBytes,
      mimeType: params.mimeType,
      blobId: params.blobId,
      scope: resolvedScope,
      metadata: params.metaData || {},
      authorId: params.userId,
    });
    await this.nodeRepo.create(node);

    const scopeKey = params.projectId ?? params.userId;
    if (this.cache) {
      await this.cache.invalidateFolder?.(scopeKey, params.parentId ?? null);
      await this.cache.invalidateScopeTree?.(scopeKey);
    }

    this.eventEmitter?.emit(
      'file.uploaded',
      new FileUploadedEvent(
        fileId,
        params.blobId,
        params.userId,
        params.filename,
        params.mimeType,
        params.sizeBytes,
        params.storageKey,
        params.projectId,
      ),
    );

    return fileId;
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
    });

    const sizeBytes = BigInt(uploaded.size);
    const fileId = await this.persistUploadedNode({
      blobId: uploaded.blobId,
      userId: input.userId,
      filename: uploaded.filename,
      mimeType: uploaded.mimeType,
      sizeBytes,
      storageKey: uploaded.path,
      projectId: input.projectId,
      parentId: input.parentId,
      linkedToType: input.linkedToType,
      linkedToId: input.linkedToId,
      scope: input.scope,
      metaData: input.metaData,
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
      const fileId = await this.persistUploadedNode({
        blobId: res.blob.id,
        userId: input.userId,
        filename: res.cleanFilename,
        mimeType: input.mimeType,
        sizeBytes: res.blob.sizeBytes,
        storageKey: res.storageKey,
        projectId: input.projectId,
        parentId: input.parentId,
        scope: input.scope,
        metaData: input.metaData,
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

    const fileId = await this.persistUploadedNode({
      blobId: completed.blobId,
      userId: input.userId,
      filename: completed.cleanFilename,
      mimeType: completed.mimeType,
      sizeBytes: completed.sizeBytes,
      storageKey: completed.blob.s3Key,
      projectId: input.projectId,
      parentId: input.parentId,
      scope: input.scope,
      metaData: input.metaData,
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

  async initiateMultipart(input: InitiateMultipartInput) {
    const targetSpaceId = input.projectId ?? input.userId;
    const res = await this.filesPort.initiateMultipart({
      userId: input.userId,
      spaceId: targetSpaceId,
      parentId: input.parentId ?? null,
      filename: input.filename,
      mimeType: input.mimeType,
      totalSize: input.totalSize,
      expectedHash: input.expectedHash,
    });

    if (res.deduplicated && res.blob) {
      const fileId = await this.persistUploadedNode({
        blobId: res.blob.id,
        userId: input.userId,
        filename: res.cleanFilename,
        mimeType: input.mimeType,
        sizeBytes: res.blob.sizeBytes,
        storageKey: res.storageKey,
        projectId: input.projectId,
        parentId: input.parentId,
        scope: input.scope,
      });

      return {
        deduplicated: true,
        sessionId: '',
        uploadId: '',
        partSize: 0,
        totalParts: 0,
        fileId,
        url: getFileContentPath(fileId),
        filename: res.cleanFilename,
        size: Number(res.blob.sizeBytes),
      };
    }

    return {
      sessionId: res.sessionId,
      uploadId: res.uploadId,
      partSize: res.partSize,
      totalParts: res.totalParts,
    };
  }

  async getMultipartPartUrl(
    sessionId: string,
    partNumber: number,
    actor?: MultipartActorContext,
  ): Promise<string> {
    return this.filesPort.getMultipartPartUrl(
      sessionId,
      partNumber,
      this.toFileActor(actor),
    );
  }

  async getMultipartPartUrls(
    sessionId: string,
    partNumbers: number[],
    actor?: MultipartActorContext,
  ) {
    return this.filesPort.presignMultipartParts(
      sessionId,
      partNumbers,
      this.toFileActor(actor),
    );
  }

  async completeMultipart(input: CompleteMultipartInput) {
    const { blob, session } = await this.filesPort.completeMultipart({
      sessionId: input.sessionId,
      parts: input.parts,
      actor: this.toFileActor(input.actor),
    });

    const sessionProjectId =
      session.spaceId !== session.userId ? session.spaceId : null;
    const fileId = await this.persistUploadedNode({
      blobId: blob.id,
      userId: session.userId,
      filename: session.filename,
      mimeType: session.mimeType,
      sizeBytes: session.totalSize,
      storageKey: blob.s3Key,
      projectId: sessionProjectId,
      parentId: session.parentId,
      scope: sessionProjectId ? FileScope.Project : FileScope.Personal,
    });

    return {
      fileId,
      blobId: blob.id,
      url: getFileContentPath(fileId),
      filename: session.filename,
      size: Number(session.totalSize),
    };
  }

  async abortMultipart(
    sessionId: string,
    actor?: MultipartActorContext,
  ): Promise<void> {
    await this.filesPort.abortMultipart(sessionId, this.toFileActor(actor));
  }
}
