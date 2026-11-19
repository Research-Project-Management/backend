import { Injectable, Inject } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as crypto from 'crypto';
import {
  FILES_PORT,
  type FileActorContext,
  type IFilesPort,
} from '@/modules/files';
import { EXPERIMENT_NODE_REPOSITORY } from '../experiments.constant';
import {
  CompleteMultipartInput,
  CompleteMultipartOutput,
  getFileContentPath,
  InitiateMultipartInput,
  MultipartActorContext,
} from '../experiments.type';
import { INodeRepository } from '../repositories/node.repository';
import { ExperimentNode } from '../domain/node.domain';
import { FileUploadedEvent } from '../domain/experiments.event';
import { ExperimentsCacheService } from './cache.service';

export type {
  MultipartActorContext,
  InitiateMultipartInput,
  CompleteMultipartInput,
  CompleteMultipartOutput,
};

@Injectable()
export class MultipartService {
  constructor(
    @Inject(FILES_PORT)
    private readonly filesPort: IFilesPort,
    @Inject(EXPERIMENT_NODE_REPOSITORY)
    private readonly nodeRepo: INodeRepository,
    private readonly cache: ExperimentsCacheService,
    private readonly eventEmitter: EventEmitter2,
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

  async initiate(input: InitiateMultipartInput) {
    const targetSpaceId = input.projectId ?? input.userId;
    const res = await this.filesPort.initiateMultipart({
      userId: input.userId,
      spaceId: targetSpaceId,
      parentId: input.parentId ?? null,
      scope: input.scope,
      filename: input.filename,
      mimeType: input.mimeType,
      totalSize: input.totalSize,
      expectedHash: input.expectedHash,
    });

    if (res.deduplicated && res.blob) {
      const fileId = crypto.randomUUID();
      const node = new ExperimentNode({
        id: fileId,
        projectId: input.projectId ?? null,
        parentId: input.parentId ?? null,
        name: res.cleanFilename,
        isFolder: false,
        size: res.blob.sizeBytes,
        mimeType: input.mimeType,
        blobId: res.blob.id,
        scope: input.scope,
        authorId: input.userId,
      });
      await this.nodeRepo.create(node);

      const scopeKey = input.projectId ?? input.userId;
      await this.cache?.invalidateFolder?.(scopeKey, input.parentId ?? null);
      await this.cache?.invalidateScopeTree?.(scopeKey);

      this.eventEmitter?.emit(
        'file.uploaded',
        new FileUploadedEvent(
          fileId,
          res.blob.id,
          input.userId,
          res.cleanFilename,
          input.mimeType,
          res.blob.sizeBytes,
          res.storageKey,
          input.projectId,
        ),
      );

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

  async getPartUrl(
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

  async complete(input: CompleteMultipartInput) {
    const { blob, session } = await this.filesPort.completeMultipart({
      sessionId: input.sessionId,
      parts: input.parts,
      actor: this.toFileActor(input.actor),
    });

    const sessionProjectId =
      session.spaceId !== session.userId ? session.spaceId : null;
    const fileId = crypto.randomUUID();
    const node = new ExperimentNode({
      id: fileId,
      projectId: sessionProjectId,
      parentId: session.parentId,
      name: session.filename,
      isFolder: false,
      size: session.totalSize,
      mimeType: session.mimeType,
      blobId: blob.id,
      scope: session.scope,
      authorId: session.userId,
    });
    await this.nodeRepo.create(node);

    const scopeKey = session.spaceId;
    await this.cache?.invalidateFolder?.(scopeKey, session.parentId);
    if (typeof this.cache?.invalidateScopeTree === 'function') {
      await this.cache.invalidateScopeTree(scopeKey);
    }

    this.eventEmitter?.emit(
      'file.uploaded',
      new FileUploadedEvent(
        fileId,
        blob.id,
        session.userId,
        session.filename,
        session.mimeType,
        session.totalSize,
        blob.s3Key.value(),
        sessionProjectId,
      ),
    );

    return {
      fileId,
      blobId: blob.id,
      url: getFileContentPath(fileId),
      filename: session.filename,
      size: Number(session.totalSize),
    };
  }

  async abort(sessionId: string, actor?: MultipartActorContext): Promise<void> {
    await this.filesPort.abortMultipart(sessionId, this.toFileActor(actor));
  }
}
