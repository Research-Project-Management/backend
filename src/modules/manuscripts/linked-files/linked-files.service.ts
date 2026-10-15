/**
 * linked-files/linked-files.service.ts
 * Deep Module Service for Manuscripts Linked Files.
 * Consolidates external URL / reference library linking, SSRF-guarded downloads,
 * on-demand & background refresh, listing, and deletion.
 */

import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
  Optional,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { LinkedFilesRepository } from './linked-files.repository';
import {
  CreateLinkedFileDto,
  LinkedFileResponseDto,
} from './dto/linked-file.dto';
import { LinkedFileEntity } from './core/domain/entities/linked-file.entity';
import { assertSafeExternalUrl } from './domain/ssrf-guard';
import { StructureService } from '@/modules/manuscripts/structure/structure.service';
import { DocstoreService } from '@/modules/manuscripts/docstore/docstore.service';
import { FilestoreService } from '@/modules/manuscripts/filestore/filestore.service';
import { CitationsService } from '@/modules/manuscripts/citations/citations.service';
import { RealtimeService } from '@/modules/realtime/realtime.service';
import { LineArrayEngine } from '@/modules/manuscripts/docstore/domain';
import { CreateLinkedFileUseCase } from './core/use-cases/create-linked-file.use-case';
import { RefreshLinkedFileUseCase } from './core/use-cases/refresh-linked-file.use-case';
import { ListLinkedFilesUseCase } from './core/use-cases/list-linked-files.use-case';
import { DeleteLinkedFileUseCase } from './core/use-cases/delete-linked-file.use-case';

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
export class LinkedFilesService {
  private readonly logger = new Logger(LinkedFilesService.name);
  private readonly MAX_DOWNLOAD_SIZE_BYTES = 50 * 1024 * 1024; // 50MB limit

  private readonly repository?: LinkedFilesRepository;
  private readonly structureService?: StructureService;
  private readonly docstoreService?: DocstoreService;
  private readonly filestoreService?: FilestoreService;
  private readonly citationsService?: CitationsService;
  private readonly realtimeService?: RealtimeService;

  private readonly legacyCreateUseCase?: CreateLinkedFileUseCase;
  private readonly legacyRefreshUseCase?: RefreshLinkedFileUseCase;
  private readonly legacyListUseCase?: ListLinkedFilesUseCase;
  private readonly legacyDeleteUseCase?: DeleteLinkedFileUseCase;

  constructor(
    repoOrCreateUseCase: LinkedFilesRepository | CreateLinkedFileUseCase,
    @Optional()
    structureOrRefreshUseCase?: StructureService | RefreshLinkedFileUseCase,
    @Optional()
    docstoreOrListUseCase?: DocstoreService | ListLinkedFilesUseCase,
    @Optional()
    filestoreOrDeleteUseCase?: FilestoreService | DeleteLinkedFileUseCase,
    @Optional() citationsOrRepo?: CitationsService | LinkedFilesRepository,
    @Optional() realtimeService?: RealtimeService,
  ) {
    if (repoOrCreateUseCase instanceof LinkedFilesRepository) {
      this.repository = repoOrCreateUseCase;
      this.structureService = structureOrRefreshUseCase as StructureService;
      this.docstoreService = docstoreOrListUseCase as DocstoreService;
      this.filestoreService = filestoreOrDeleteUseCase as FilestoreService;
      this.citationsService = citationsOrRepo as CitationsService;
      this.realtimeService = realtimeService;
    } else {
      this.legacyCreateUseCase = repoOrCreateUseCase;
      this.legacyRefreshUseCase =
        structureOrRefreshUseCase as RefreshLinkedFileUseCase;
      this.legacyListUseCase = docstoreOrListUseCase as ListLinkedFilesUseCase;
      this.legacyDeleteUseCase =
        filestoreOrDeleteUseCase as DeleteLinkedFileUseCase;
      this.repository = citationsOrRepo as LinkedFilesRepository;
    }
  }

  public async create(
    projectId: string,
    dto: CreateLinkedFileDto,
    userId?: string,
  ): Promise<LinkedFileResponseDto> {
    if (this.legacyCreateUseCase) {
      const entity = await this.legacyCreateUseCase.execute(
        projectId,
        dto,
        userId,
      );
      return this.mapToDto(entity);
    }

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
          const doc = await this.docstoreService!.createDoc(projectId, {
            path: filename,
            text: textContent,
          });
          docId = doc._id;

          const node = await this.structureService!.createNode(projectId, {
            name: filename,
            type: 'DOC',
            parentId: dto.parentFolderId || null,
            docId,
          });
          nodeId = node.id;
        } else {
          const uploadedFile =
            await this.filestoreService!.uploadFileFromBuffer(
              projectId,
              filename,
              download.buffer,
              download.mimeType,
            );
          fileId = uploadedFile.id;

          const node = await this.structureService!.createNode(projectId, {
            name: filename,
            type: 'FILE',
            parentId: dto.parentFolderId || null,
            fileId,
          });
          nodeId = node.id;
        }
      } catch (err: unknown) {
        this.logger.error(
          `Failed to link URL ${dto.url}: ${(err as Error)?.message}`,
        );
        throw new BadRequestException(
          `Failed to link external URL: ${(err as Error)?.message}`,
        );
      }
    } else if (dto.provider === 'zotero' || dto.provider === 'mendeley') {
      if (!dto.collectionId) {
        throw new BadRequestException(
          'Collection ID is required for reference library provider',
        );
      }

      try {
        await this.citationsService!.syncLibraryCollection(
          projectId,
          userId || 'anonymous',
          {
            collectionId: dto.collectionId,
            targetFilename: filename,
          },
        );

        const existingNode = await this.structureService!.getNodeByPath(
          projectId,
          filename,
        );
        if (existingNode) {
          nodeId = existingNode.id;
          docId = existingNode.docId;
        }
      } catch (err: unknown) {
        this.logger.error(
          `Failed to link library collection ${dto.collectionId}: ${(err as Error)?.message}`,
        );
        throw new BadRequestException(
          `Failed to link reference collection: ${(err as Error)?.message}`,
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

    await this.repository!.save(entity);

    this.realtimeService?.broadcastFileTreeChange(projectId, {
      action: 'linked-file-created',
      node: { id: nodeId, name: filename, linkedFileId },
    });

    return this.mapToDto(entity);
  }

  public async refresh(
    projectId: string,
    fileIdOrLinkedFileId: string,
    userId?: string,
  ): Promise<LinkedFileResponseDto> {
    if (this.legacyRefreshUseCase) {
      const entity = await this.legacyRefreshUseCase.execute(
        projectId,
        fileIdOrLinkedFileId,
        userId,
      );
      return this.mapToDto(entity);
    }

    let linkedFile = await this.repository!.findById(
      projectId,
      fileIdOrLinkedFileId,
    );
    if (!linkedFile) {
      linkedFile = await this.repository!.findByNodeId(
        projectId,
        fileIdOrLinkedFileId,
      );
    }

    if (!linkedFile) {
      throw new NotFoundException(
        `Linked file "${fileIdOrLinkedFileId}" not found in project "${projectId}"`,
      );
    }

    try {
      if (linkedFile.provider === 'url' && linkedFile.url) {
        const download = await this.downloadUrl(linkedFile.url);

        if (linkedFile.docId) {
          const textContent = download.buffer.toString('utf8');
          const lines = LineArrayEngine.textToLines(textContent);
          const currentDoc = await this.docstoreService!.getDoc(
            projectId,
            linkedFile.docId,
          ).catch(() => null);
          const nextVersion = (currentDoc?.version ?? 0) + 1;
          await this.docstoreService!.updateDoc(projectId, linkedFile.docId, {
            lines,
            version: nextVersion,
          });

          this.realtimeService?.broadcastEvent(
            projectId,
            'doc:content-updated',
            {
              docId: linkedFile.docId,
            },
          );
        } else if (linkedFile.fileId) {
          const newFile = await this.filestoreService!.uploadFileFromBuffer(
            projectId,
            linkedFile.name,
            download.buffer,
            download.mimeType,
          );
          linkedFile.fileId = newFile.id;
          if (linkedFile.nodeId) {
            await this.structureService!.updateNodeFileId(
              projectId,
              linkedFile.nodeId,
              newFile.id,
              download.buffer.length,
              newFile.hash?.getValue() ?? null,
            );
          }
        }
      } else if (
        (linkedFile.provider === 'zotero' ||
          linkedFile.provider === 'mendeley') &&
        linkedFile.collectionId
      ) {
        await this.citationsService!.syncLibraryCollection(
          projectId,
          userId || 'anonymous',
          {
            collectionId: linkedFile.collectionId,
            targetFilename: linkedFile.name,
          },
        );

        if (linkedFile.docId) {
          this.realtimeService?.broadcastEvent(
            projectId,
            'doc:content-updated',
            {
              docId: linkedFile.docId,
            },
          );
        }
      }

      linkedFile.markSynced(
        linkedFile.nodeId ?? undefined,
        linkedFile.docId ?? undefined,
        linkedFile.fileId ?? undefined,
      );
      await this.repository!.save(linkedFile);

      this.realtimeService?.broadcastFileTreeChange(projectId, {
        action: 'linked-file-refreshed',
        node: {
          id: linkedFile.nodeId,
          name: linkedFile.name,
          linkedFileId: linkedFile.id,
        },
      });

      return this.mapToDto(linkedFile);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      linkedFile.markFailed(errorMessage || 'Refresh failed');
      await this.repository!.save(linkedFile);
      this.logger.warn(
        `Failed to refresh linked file ${linkedFile.id}: ${errorMessage}`,
      );
      throw new BadRequestException(`Refresh failed: ${errorMessage}`);
    }
  }

  public async list(projectId: string): Promise<LinkedFileResponseDto[]> {
    if (this.legacyListUseCase) {
      const entities = await this.legacyListUseCase.execute(projectId);
      return entities.map((e) => this.mapToDto(e));
    }

    const entities = await this.repository!.findByProject(projectId);
    return entities.map((e) => this.mapToDto(e));
  }

  public async delete(
    projectId: string,
    id: string,
    deleteNode = false,
  ): Promise<void> {
    if (this.legacyDeleteUseCase) {
      await this.legacyDeleteUseCase.execute(projectId, id, deleteNode);
      return;
    }

    const linkedFile = await this.repository!.findById(projectId, id);
    if (!linkedFile) {
      throw new NotFoundException(`Linked file "${id}" not found`);
    }

    if (deleteNode && linkedFile.nodeId) {
      await this.structureService!.deleteNode(
        projectId,
        linkedFile.nodeId,
      ).catch(() => {});
    }

    await this.repository!.delete(projectId, id);
  }

  /**
   * Refreshes all linked files with autoRefresh enabled.
   * Called by background workers or schedulers.
   */
  public async refreshAllAutoRefresh(): Promise<{
    total: number;
    succeeded: number;
    failed: number;
  }> {
    if (!this.repository) {
      return { total: 0, succeeded: 0, failed: 0 };
    }
    const autoFiles = await this.repository.findAllAutoRefresh();
    let succeeded = 0;
    let failed = 0;

    for (const item of autoFiles) {
      try {
        await this.refresh(item.projectId, item.id);
        succeeded++;
      } catch (err: unknown) {
        failed++;
        this.logger.warn(
          `Auto-refresh failed for linked file ${item.id} (${item.name}): ${(err as Error)?.message}`,
        );
      }
    }

    return { total: autoFiles.length, succeeded, failed };
  }

  private async downloadUrl(
    url: string,
  ): Promise<{ buffer: Buffer; mimeType: string }> {
    const validatedUrl = await assertSafeExternalUrl(url);

    const response = await fetch(validatedUrl.toString(), {
      signal: AbortSignal.timeout(30000),
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

  private mapToDto(entity: LinkedFileEntity): LinkedFileResponseDto {
    return {
      id: entity.id,
      projectId: entity.projectId,
      name: entity.name,
      provider: entity.provider,
      providerType: entity.provider.toUpperCase(),
      url: entity.url,
      collectionId: entity.collectionId,
      nodeId: entity.nodeId,
      docId: entity.docId,
      fileId: entity.fileId,
      status: entity.status,
      lastSyncedAt: entity.lastSyncedAt?.toISOString() ?? null,
      errorMessage: entity.errorMessage,
      autoRefresh: entity.autoRefresh,
      createdAt: entity.createdAt.toISOString(),
      updatedAt: entity.updatedAt.toISOString(),
    };
  }
}
