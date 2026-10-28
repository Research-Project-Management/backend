/**
 * filestore/filestore.service.ts
 * Deep Module Service for Manuscripts Filestore.
 * Consolidates Content-Addressable Storage (CAS) upload, byte-range streaming,
 * metadata queries, signed URLs, and reference-counted deletion.
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import { Readable } from 'node:stream';
import { FilestoreRepository } from './filestore.repository';
import {
  ManuscriptFile,
  ByteRange,
  FileNotFoundException,
  StorageObjectMetadata,
  StreamManuscriptFileOutput,
  GetFileHeadOutput,
} from './filestore.types';

@Injectable()
export class FilestoreService {
  private readonly logger = new Logger(FilestoreService.name);

  constructor(private readonly repository: FilestoreRepository) {}

  /**
   * Directly opens a readable stream for a file without passing through HTTP.
   * Used by ClsiService and GitBridgeService to hydrate workspaces with figures, fonts, and packages.
   */
  public async openReadStream(
    projectId: string,
    fileId: string,
  ): Promise<{ file: ManuscriptFile; stream: Readable }> {
    const result = await this.streamFile(projectId, fileId);
    return {
      file: result.file,
      stream: result.stream,
    };
  }

  /**
   * Streams binary content with optional RFC 7233 byte-range slicing.
   */
  public async streamFile(
    projectId: string,
    fileId: string,
    rangeHeader?: string,
  ): Promise<StreamManuscriptFileOutput> {
    const file = await this.repository.findByProjectAndId(projectId, fileId);
    if (!file || file.deleted) {
      throw new FileNotFoundException(fileId, projectId);
    }

    const byteRange = ByteRange.parse(rangeHeader, file.sizeBytes);
    const rangeOpts = byteRange
      ? { start: byteRange.start, end: byteRange.end }
      : undefined;

    const stream = await this.repository.getObjectStream(
      file.bucketName,
      file.storageKey.getValue(),
      rangeOpts,
    );

    const isPartialContent = byteRange !== null;
    const contentLength = byteRange ? byteRange.contentLength : file.sizeBytes;

    return {
      file,
      stream,
      byteRange,
      isPartialContent,
      contentLength,
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
    options?: { syncStructureNode?: boolean },
  ): Promise<ManuscriptFile> {
    const stream = Readable.from(buffer);
    return await this.uploadFileFromStream(
      projectId,
      name,
      stream,
      mimeType,
      'manuscript-files',
      { syncStructureNode: options?.syncStructureNode ?? false },
    );
  }

  /**
   * Programmatic upload of binary asset from a readable stream with Git-blob CAS deduplication.
   */
  public async uploadFileFromStream(
    projectId: string,
    name: string,
    stream: Readable,
    mimeType?: string,
    bucketName = 'manuscript-files',
    options?: { syncStructureNode?: boolean },
  ): Promise<ManuscriptFile> {
    const { contentHash, sizeBytes, dataStream } =
      await this.repository.hashStream(stream);
    const storageKey = this.repository.buildStorageKey(contentHash);

    const blobExists = await this.repository.checkObjectExists(
      bucketName,
      storageKey.getValue(),
    );

    if (blobExists) {
      dataStream.destroy();
      this.logger.log(
        `[CAS Deduplication] Reusing existing blob '${storageKey.getValue()}' for file '${name}' in project '${projectId}'. (0 bytes written to storage)`,
      );
    } else {
      await this.repository.sendStream(
        bucketName,
        storageKey.getValue(),
        dataStream,
        {
          contentType: mimeType || 'application/octet-stream',
        },
      );
      this.logger.log(
        `[CAS Write] Stored new blob '${storageKey.getValue()}' (${sizeBytes} bytes) for project '${projectId}'.`,
      );
    }

    const existing = await this.repository.findByProjectAndName(
      projectId,
      name,
    );

    const fileEntity = ManuscriptFile.reconstitute({
      id: existing?.id ?? ManuscriptFile.create({
        projectId,
        name,
        mimeType: mimeType || 'application/octet-stream',
        sizeBytes,
        hash: contentHash,
        storageKey,
        bucketName,
      }).id,
      projectId,
      name,
      mimeType: mimeType || 'application/octet-stream',
      sizeBytes,
      hash: contentHash,
      storageKey,
      bucketName,
      rev: existing ? existing.rev + 1 : 0,
      deleted: false,
      deletedAt: null,
      createdAt: existing?.createdAt ?? new Date(),
      updatedAt: new Date(),
    });

    return await (
      this.repository.save as (
        f: ManuscriptFile,
        opts?: { syncStructureNode?: boolean },
      ) => Promise<ManuscriptFile>
    )(fileEntity, options);
  }

  /**
   * Fast metadata and storage header retrieval without payload download.
   */
  public async getFileHead(
    projectId: string,
    fileId: string,
  ): Promise<GetFileHeadOutput> {
    const file = await this.repository.findByProjectAndId(projectId, fileId);
    if (!file || file.deleted) {
      throw new FileNotFoundException(fileId, projectId);
    }

    let storageMetadata: StorageObjectMetadata | undefined;
    try {
      storageMetadata = await this.repository.getObjectMetadata?.(
        file.bucketName,
        file.storageKey.getValue(),
      );
    } catch {
      // Storage metadata optional; file entity sizeBytes is authoritative
    }

    return { file, storageMetadata };
  }

  /**
   * Fast metadata query.
   */
  public async getFileMetadata(
    projectId: string,
    fileId: string,
  ): Promise<ManuscriptFile> {
    const result = await this.getFileHead(projectId, fileId);
    return result.file;
  }

  /**
   * List all files in a manuscript project.
   */
  public async listFiles(
    projectId: string,
    includeDeleted = false,
  ): Promise<ManuscriptFile[]> {
    return await this.repository.listByProject(projectId, includeDeleted);
  }

  /**
   * Find file by project ID and relative path / leaf name.
   */
  public async findByProjectAndName(
    projectId: string,
    name: string,
  ): Promise<ManuscriptFile | null> {
    return await this.repository.findByProjectAndName(projectId, name);
  }

  /**
   * Resolve file by exact path, leaf basename, or implicit LaTeX graphics extension in a single query.
   */
  public async findFileByPathFlexible(
    projectId: string,
    rawPath: string,
  ): Promise<ManuscriptFile | null> {
    return await this.repository.findFileByPathFlexible(projectId, rawPath);
  }

  /**
   * Delete file record and optionally garbage-collect unreferenced physical CAS blob.
   */
  public async deleteFile(
    projectId: string,
    fileId: string,
    purgeBlob = false,
  ): Promise<void> {
    const file = await this.repository.findByProjectAndId(projectId, fileId);
    if (!file || file.deleted) {
      throw new FileNotFoundException(fileId, projectId);
    }

    file.markDeleted();
    await this.repository.save(file);

    if (purgeBlob) {
      const remainingRefs = await this.repository.countReferencesByHash(
        file.hash.getValue(),
      );
      if (remainingRefs === 0) {
        try {
          await this.repository.deleteObject(
            file.bucketName,
            file.storageKey.getValue(),
          );
          this.logger.log(
            `[CAS GC] Purged unreferenced physical blob '${file.storageKey.getValue()}'.`,
          );
        } catch (err) {
          this.logger.warn(
            `[CAS GC] Failed to purge blob '${file.storageKey.getValue()}': ${(err as Error).message}`,
          );
        }
      }
    }
  }

  /**
   * Restores a soft-deleted file record in the project (used for Memento/Saga rollback).
   */
  public async restoreFile(projectId: string, fileId: string): Promise<boolean> {
    const file = await this.repository.findByProjectAndId(projectId, fileId);
    if (!file) return false;
    if (file.deleted) {
      file.restore();
      await this.repository.save(file);
    }
    return true;
  }

  /**
   * Generate pre-signed URL.
   */
  public async getSignedUrl(
    projectId: string,
    fileId: string,
    expiresIn = 3600,
  ): Promise<string | null> {
    const file = await this.repository.findByProjectAndId(projectId, fileId);
    if (!file || file.deleted) {
      throw new FileNotFoundException(fileId, projectId);
    }

    const signedUrl = await this.repository.getSignedDownloadUrl(
      file.bucketName,
      file.storageKey.getValue(),
      expiresIn,
    );

    if (
      !signedUrl ||
      signedUrl.startsWith('/api/manuscripts/filestore/download/')
    ) {
      return `/api/v1/manuscripts/projects/${projectId}/files/${file.id}`;
    }

    return signedUrl;
  }
}
