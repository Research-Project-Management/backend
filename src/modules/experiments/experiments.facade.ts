import {
  Injectable,
  Inject,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { FILES_PORT } from '@/modules/files/files.constant';
import { streamToBuffer } from '@/modules/files/domain/files.policy';
import { type IFilesPort } from '@/modules/files/types/files.type';
import {
  getFileContentPath,
  IExperimentsPort,
  LinkFileInput,
  ReadOwnedFileInput,
  ReadOwnedFileOutput,
  UploadFileInput,
  UploadFileOutput,
} from './experiments.type';
import { NodeRepository } from './repositories/node.repository';
import { FileScope } from './domain/node.domain';
import { ExperimentsAccessPolicy } from './domain/access.policy';
import { ExperimentsService } from './services/experiments.service';
import { TrashService } from './services/trash.service';
import { UploadService } from './services/upload.service';
import { StreamService } from './services/stream.service';

@Injectable()
export class ExperimentsFacade implements IExperimentsPort {
  constructor(
    @Inject(FILES_PORT)
    private readonly filesPort: IFilesPort,
    private readonly nodeRepo: NodeRepository,
    private readonly uploadService: UploadService,
    private readonly trashService: TrashService,
    private readonly streamService: StreamService,
    private readonly experimentsService: ExperimentsService,
    private readonly accessPolicy: ExperimentsAccessPolicy,
  ) {}

  private async verifyNodeAccess(
    node: { id: string; authorId: string; projectId: string | null },
    userId?: string,
    projectId?: string | null,
  ): Promise<void> {
    if (projectId && node.projectId && node.projectId !== projectId) {
      throw new ForbiddenException(
        'Access denied: Storage node belongs to a different project context',
      );
    }
    if (!userId || userId === 'system') return;
    await this.accessPolicy.assertCanAccess(userId, node.id, 'read');
  }

  private async resolveActiveNodeAndBlob(
    fileId: string,
    userId?: string,
    projectId?: string | null,
  ) {
    const node = await this.nodeRepo.findById(fileId);
    if (!node || node.isTrashed()) {
      throw new NotFoundException(`Storage node not found: ${fileId}`);
    }
    await this.verifyNodeAccess(node, userId, projectId);
    if (!node.blobId) {
      throw new NotFoundException(
        `File has no physical binary payload: ${fileId}`,
      );
    }
    const blob = await this.filesPort.findBlobById(node.blobId);
    if (!blob) {
      throw new NotFoundException(
        `Physical storage blob not found for node: ${fileId}`,
      );
    }
    return { node, blob };
  }

  async assertFileAccess(
    fileId: string,
    userId?: string,
    projectId?: string | null,
  ): Promise<void> {
    const node = await this.nodeRepo.findById(fileId);
    if (!node || node.isTrashed()) {
      throw new NotFoundException(`Storage node not found: ${fileId}`);
    }
    await this.verifyNodeAccess(node, userId, projectId);
  }

  async readOwnedFile(input: ReadOwnedFileInput): Promise<ReadOwnedFileOutput> {
    const { node, blob } = await this.resolveActiveNodeAndBlob(
      input.fileId,
      input.userId,
      input.projectId,
    );

    const { stream } = await this.filesPort.getObjectStream(blob.s3Key);
    const buffer = await streamToBuffer(stream);

    return {
      fileId: node.id,
      filename: node.name,
      mimeType: node.mimeType,
      size: Number(blob.sizeBytes),
      storageKey: blob.s3Key,
      contentUrl: getFileContentPath(node.id),
      buffer,
    };
  }

  async getOwnedFileStream(
    input: ReadOwnedFileInput & { range?: { start: number; end: number } },
  ): Promise<{
    stream: NodeJS.ReadableStream;
    mimeType: string;
    size: number;
    filename: string;
    contentRange?: string;
  }> {
    const { node, blob } = await this.resolveActiveNodeAndBlob(
      input.fileId,
      input.userId,
      input.projectId,
    );

    const { stream, contentLength, contentRange } =
      await this.filesPort.getObjectStream(blob.s3Key, input.range);

    return {
      stream,
      mimeType: node.mimeType,
      size: contentLength,
      filename: node.name,
      contentRange,
    };
  }

  async ensurePdfThumbnail(input: {
    fileId: string;
    userId?: string;
    projectId?: string | null;
  }): Promise<Buffer | null> {
    const { node, blob } = await this.resolveActiveNodeAndBlob(
      input.fileId,
      input.userId,
      input.projectId,
    );

    const thumbBuffer = await this.filesPort.ensurePdfThumbnail({
      fileId: blob.id,
      userId: input.userId,
      spaceId: input.projectId ?? input.userId,
    });
    if (!thumbBuffer) {
      return null;
    }

    try {
      const thumbnailUrl = this.filesPort.getThumbnailUrl(
        blob.id,
        blob.contentHashHex,
      );
      if (node.metadata?.thumbnail !== thumbnailUrl) {
        node.updateMetadata({
          ...(node.metadata || {}),
          thumbnail: thumbnailUrl,
        });
        await this.nodeRepo.update(node);
      }
    } catch {
      // Non-fatal if persisting cached thumbnail URL fails
    }

    return thumbBuffer;
  }

  async linkFile(input: LinkFileInput): Promise<void> {
    await this.experimentsService.linkScope(
      input.fileId,
      input.linkedToType,
      input.linkedToId,
    );
  }

  async uploadFile(input: UploadFileInput): Promise<UploadFileOutput> {
    const res = await this.uploadService.upload({
      userId: input.userId,
      filename: input.filename,
      buffer: input.buffer,
      mimeType: input.mimeType,
      projectId: input.projectId,
      parentId: input.parentId,
      scope: input.projectId ? FileScope.Project : FileScope.Personal,
    });

    return {
      fileId: res.fileId,
      url: res.url,
      path: res.url,
      filename: res.filename,
      size: res.size,
      mimeType: res.mimeType,
    };
  }

  async deleteFile(fileId: string): Promise<void> {
    await this.trashService.softDelete(fileId);
  }

  async getPresignedDownloadUrl(
    fileId: string,
    expiresInSeconds = 3600,
    userId?: string,
  ): Promise<string> {
    return this.streamService.getPresignedDownloadUrl(
      fileId,
      expiresInSeconds,
      userId,
    );
  }

  async getPresignedUploadUrl(input: {
    userId: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    contentHash?: string;
    projectId?: string | null;
    parentId?: string | null;
    scope?: FileScope | string;
  }) {
    return this.uploadService.presign({
      ...input,
      scope: input.scope as FileScope | undefined,
    });
  }

  async completePresignedUpload(input: {
    userId: string;
    storageKey: string;
    filename: string;
    sizeBytes?: number;
    mimeType?: string;
    projectId?: string | null;
    parentId?: string | null;
    scope?: FileScope | string;
    contentHash?: string;
  }) {
    const res = await this.uploadService.complete({
      userId: input.userId,
      storageKey: input.storageKey,
      filename: input.filename,
      sizeBytes: input.sizeBytes,
      mimeType: input.mimeType,
      projectId: input.projectId,
      parentId: input.parentId,
      scope: input.scope as FileScope | undefined,
      contentHash: input.contentHash,
    });
    return {
      fileId: res.fileId,
      blobId: res.blobId,
      url: res.url,
      filename: res.filename,
      size: res.size,
      mimeType: res.mimeType,
    };
  }

  async initiateMultipartUpload(input: {
    userId: string;
    filename: string;
    mimeType: string;
    totalSize: number;
    projectId?: string | null;
    parentId?: string | null;
    scope?: FileScope | string;
    expectedHash?: string;
  }) {
    return this.uploadService.initiateMultipart({
      ...input,
      scope: input.scope as FileScope | undefined,
    });
  }

  async getMultipartPartUrl(
    sessionId: string,
    partNumber: number,
    actor?: { userId: string; projectId?: string | null },
  ): Promise<string> {
    return this.uploadService.getMultipartPartUrl(sessionId, partNumber, actor);
  }

  async completeMultipartUpload(input: {
    sessionId: string;
    parts: { partNumber: number; eTag: string }[];
    actor?: { userId: string; projectId?: string | null };
  }) {
    return this.uploadService.completeMultipart(input);
  }

  async abortMultipartUpload(
    sessionId: string,
    actor?: { userId: string; projectId?: string | null },
  ): Promise<void> {
    await this.uploadService.abortMultipart(sessionId, actor);
  }
}
