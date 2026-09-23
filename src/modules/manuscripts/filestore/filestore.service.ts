/**
 * filestore/filestore.service.ts
 * Module Façade Orchestrator providing clean internal APIs for ClsiService and StructureService.
 */

import { Injectable } from '@nestjs/common';
import { Readable } from 'node:stream';
import { UploadManuscriptFileUseCase } from './core/use-cases/upload-manuscript-file.use-case';
import { StreamManuscriptFileUseCase } from './core/use-cases/stream-manuscript-file.use-case';
import { GetManuscriptFileHeadUseCase } from './core/use-cases/get-manuscript-file-head.use-case';
import { DeleteManuscriptFileUseCase } from './core/use-cases/delete-manuscript-file.use-case';
import { GetSignedDownloadUrlUseCase } from './core/use-cases/get-signed-download-url.use-case';
import { ManuscriptFile } from './core/domain/entities/manuscript-file.entity';
import { IManuscriptFileRepository } from './core/ports/manuscript-file-repository.port';

@Injectable()
export class FilestoreService {
  constructor(
    private readonly uploadUseCase: UploadManuscriptFileUseCase,
    private readonly streamUseCase: StreamManuscriptFileUseCase,
    private readonly headUseCase: GetManuscriptFileHeadUseCase,
    private readonly deleteUseCase: DeleteManuscriptFileUseCase,
    private readonly signedUrlUseCase: GetSignedDownloadUrlUseCase,
    private readonly repository: IManuscriptFileRepository,
  ) {}

  /**
   * Directly opens a readable stream for a file without passing through HTTP.
   * Used by ClsiService to hydrate compiler workspaces with figures, fonts, and packages.
   */
  public async openReadStream(
    projectId: string,
    fileId: string,
  ): Promise<{ file: ManuscriptFile; stream: Readable }> {
    const result = await this.streamUseCase.execute({ projectId, fileId });
    return {
      file: result.file,
      stream: result.stream,
    };
  }

  /**
   * Programmatic upload of binary asset from an in-memory buffer.
   */
  public async uploadFileFromBuffer(
    projectId: string,
    name: string,
    buffer: Buffer,
    mimeType?: string,
  ): Promise<ManuscriptFile> {
    const stream = Readable.from(buffer);
    return await this.uploadUseCase.execute({
      projectId,
      name,
      mimeType,
      stream,
    });
  }

  /**
   * Programmatic upload of binary asset from a readable stream.
   */
  public async uploadFileFromStream(
    projectId: string,
    name: string,
    stream: Readable,
    mimeType?: string,
  ): Promise<ManuscriptFile> {
    return await this.uploadUseCase.execute({
      projectId,
      name,
      mimeType,
      stream,
    });
  }

  /**
   * Fast metadata query.
   */
  public async getFileMetadata(projectId: string, fileId: string): Promise<ManuscriptFile> {
    const result = await this.headUseCase.execute({ projectId, fileId });
    return result.file;
  }

  /**
   * List all files in a manuscript project.
   */
  public async listFiles(projectId: string, includeDeleted = false): Promise<ManuscriptFile[]> {
    return await this.repository.listByProject(projectId, includeDeleted);
  }

  /**
   * Delete file.
   */
  public async deleteFile(projectId: string, fileId: string, purgeBlob = false): Promise<void> {
    await this.deleteUseCase.execute({ projectId, fileId, purgePhysicalBlob: purgeBlob });
  }

  /**
   * Generate pre-signed URL.
   */
  public async getSignedUrl(projectId: string, fileId: string, expiresIn = 3600): Promise<string | null> {
    return await this.signedUrlUseCase.execute({ projectId, fileId, expiresInSeconds: expiresIn });
  }
}
