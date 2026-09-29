/**
 * linked-files/core/use-cases/create-linked-file.use-case.ts
 * Inbound Use Case: Links an external URL or reference library to a project file.
 */

import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ILinkedFilesRepositoryPort } from '../ports/linked-files-repository.port';
import {
  LinkedFileEntity,
  LinkedFileProvider,
} from '../domain/entities/linked-file.entity';
import { CreateLinkedFileDto } from '../../dto/linked-file.dto';
import { StructureService } from '@/modules/manuscripts/structure/structure.service';
import { DocstoreService } from '@/modules/manuscripts/docstore/docstore.service';
import { FilestoreService } from '@/modules/manuscripts/filestore/filestore.service';
import { CitationsService } from '@/modules/manuscripts/citations/citations.service';
import { RealtimeService } from '@/modules/realtime/realtime.service';
import { assertSafeExternalUrl } from '../utils/ssrf-guard.util';

const TEXT_EXTENSIONS = new Set([
  'tex',
  'bib',
  'csv',
  'txt',
  'json',
  'md',
  'tsv',
  'yaml',
  'yml',
  'xml',
  'r',
  'py',
  'sty',
  'cls',
]);

@Injectable()
export class CreateLinkedFileUseCase {
  private readonly logger = new Logger(CreateLinkedFileUseCase.name);
  private readonly MAX_DOWNLOAD_SIZE_BYTES = 50 * 1024 * 1024; // 50MB limit

  constructor(
    private readonly repository: ILinkedFilesRepositoryPort,
    private readonly structureService: StructureService,
    private readonly docstoreService: DocstoreService,
    private readonly filestoreService: FilestoreService,
    private readonly citationsService: CitationsService,
    private readonly realtimeService?: RealtimeService,
  ) {}

  public async execute(
    projectId: string,
    dto: CreateLinkedFileDto,
    userId?: string,
  ): Promise<LinkedFileEntity> {
    const filename = dto.name.trim();
    if (!filename) {
      throw new BadRequestException('Linked file name is required');
    }

    const linkedFileId = randomUUID();
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    const isText = TEXT_EXTENSIONS.has(ext);

    let docId: string | null = null;
    let fileId: string | null = null;
    let nodeId: string | null = null;

    if (dto.provider === 'url') {
      if (!dto.url) {
        throw new BadRequestException('URL is required for URL provider');
      }

      try {
        const download = await this.downloadUrl(dto.url);

        if (isText) {
          const textContent = download.buffer.toString('utf8');
          const doc = await this.docstoreService.createDoc(projectId, {
            path: filename,
            text: textContent,
          });
          docId = doc._id;

          const node = await this.structureService.createNode(projectId, {
            name: filename,
            type: 'DOC',
            parentId: dto.parentFolderId || null,
            docId,
          });
          nodeId = node.id;
        } else {
          const uploadedFile = await this.filestoreService.uploadFileFromBuffer(
            projectId,
            filename,
            download.buffer,
            download.mimeType,
          );
          fileId = uploadedFile.id;

          const node = await this.structureService.createNode(projectId, {
            name: filename,
            type: 'FILE',
            parentId: dto.parentFolderId || null,
            fileId,
          });
          nodeId = node.id;
        }
      } catch (err: any) {
        this.logger.error(`Failed to link URL ${dto.url}: ${err?.message}`);
        throw new BadRequestException(
          `Failed to link external URL: ${err?.message}`,
        );
      }
    } else if (dto.provider === 'zotero' || dto.provider === 'mendeley') {
      if (!dto.collectionId) {
        throw new BadRequestException(
          'Collection ID is required for reference library provider',
        );
      }

      try {
        await this.citationsService.syncLibraryCollection(
          projectId,
          userId || 'anonymous',
          {
            collectionId: dto.collectionId,
            targetFilename: filename,
          },
        );

        // Structure node was updated or created during library sync
        const existingNode = await this.structureService.getNodeByPath(
          projectId,
          filename,
        );
        if (existingNode) {
          nodeId = existingNode.id;
          docId = existingNode.docId;
        }
      } catch (err: any) {
        this.logger.error(
          `Failed to link library collection ${dto.collectionId}: ${err?.message}`,
        );
        throw new BadRequestException(
          `Failed to link reference collection: ${err?.message}`,
        );
      }
    }

    const entity = new LinkedFileEntity({
      id: linkedFileId,
      projectId,
      name: filename,
      provider: dto.provider,
      url: dto.url,
      collectionId: dto.collectionId,
      nodeId,
      docId,
      fileId,
      status: 'synced',
      lastSyncedAt: new Date(),
      autoRefresh: dto.autoRefresh ?? false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await this.repository.save(entity);

    // Broadcast file tree update
    this.realtimeService?.broadcastFileTreeChange(projectId, {
      action: 'linked-file-created',
      node: { id: nodeId, name: filename, linkedFileId },
    });

    return entity;
  }

  private async downloadUrl(
    url: string,
  ): Promise<{ buffer: Buffer; mimeType: string }> {
    const validatedUrl = await assertSafeExternalUrl(url);

    const response = await fetch(validatedUrl.toString(), {
      signal: AbortSignal.timeout(30000), // 30s timeout
      headers: {
        'User-Agent': 'Flux-Manuscript-LinkedFiles/1.0',
      },
    });

    if (!response.ok) {
      throw new Error(
        `Remote server returned HTTP ${response.status} ${response.statusText}`,
      );
    }

    const contentLength = Number(response.headers.get('content-length') || '0');
    if (contentLength > this.MAX_DOWNLOAD_SIZE_BYTES) {
      throw new Error(
        `File exceeds maximum permitted size of 50MB (${contentLength} bytes)`,
      );
    }

    const mimeType =
      response.headers.get('content-type') || 'application/octet-stream';
    const arrayBuf = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuf);

    if (buffer.length > this.MAX_DOWNLOAD_SIZE_BYTES) {
      throw new Error(`File exceeds maximum permitted size of 50MB`);
    }

    return { buffer, mimeType };
  }
}
