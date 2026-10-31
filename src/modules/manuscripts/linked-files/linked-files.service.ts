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
  PayloadTooLargeException,
  Logger,
  Optional,
  Inject,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { randomUUID } from 'node:crypto';
import { LinkedFilesRepository } from './linked-files.repository';
import {
  CreateLinkedFileDto,
  LinkedFileResponseDto,
} from './dto/linked-file.dto';
import { LinkedFileEntity, assertSafeExternalUrl } from './domain';
import { StructureService } from '@/modules/manuscripts/structure/structure.service';
import { DocstoreService } from '@/modules/manuscripts/docstore/docstore.service';
import { FilestoreService } from '@/modules/manuscripts/filestore/filestore.service';
import { CitationsService } from '@/modules/manuscripts/citations/citations.service';
import { LineArrayEngine } from '@/modules/manuscripts/docstore/domain';
import {
  TEXT_EXTENSIONS,
  LIVE_COLLABORATION_PORT,
  LiveCollaborationPort,
  NOOP_LIVE_COLLABORATION,
  ManuscriptDomainEventBus,
  SagaRunner,
} from '@/modules/manuscripts/core';

@Injectable()
export class LinkedFilesService {
  private readonly logger = new Logger(LinkedFilesService.name);
  private readonly MAX_DOWNLOAD_SIZE_BYTES = 50 * 1024 * 1024; // 50MB limit
  private readonly liveCollab: LiveCollaborationPort;

  constructor(
    private readonly repository: LinkedFilesRepository,
    @Optional() private readonly structureService?: StructureService,
    @Optional() private readonly docstoreService?: DocstoreService,
    @Optional() private readonly filestoreService?: FilestoreService,
    @Optional() private readonly citationsService?: CitationsService,
    @Optional() private readonly eventEmitter?: EventEmitter2,
    @Optional()
    @Inject(LIVE_COLLABORATION_PORT)
    liveCollab?: LiveCollaborationPort,
    @Optional()
    private readonly domainEventBus?: ManuscriptDomainEventBus,
  ) {
    this.liveCollab = liveCollab ?? NOOP_LIVE_COLLABORATION;
    this.domainEventBus?.subscribe(
      'manuscript.nodes.deleted',
      async (event) => {
        if (event.type !== 'manuscript.nodes.deleted' || !event.projectId || !this.repository) {
          return;
        }
        const deletedDocIds = new Set(event.deletedDocIds ?? []);
        const deletedFileIds = new Set(event.deletedFileIds ?? []);
        if (deletedDocIds.size === 0 && deletedFileIds.size === 0) {
          return;
        }
        try {
          const linkedList = await this.repository.findByProject(event.projectId);
          for (const linked of linkedList) {
            if (
              (linked.docId && deletedDocIds.has(linked.docId)) ||
              (linked.fileId && deletedFileIds.has(linked.fileId))
            ) {
              await this.repository.delete(event.projectId, linked.id);
            }
          }
        } catch {
          // Ignore cleanup errors
        }
      },
    );
  }

  private broadcastFileTreeChange(
    projectId: string,
    change: { action: string; node: unknown },
  ): void {
    this.eventEmitter?.emit('manuscripts.file-tree.change', {
      projectId,
      change,
    });
  }

  public async create(
    projectId: string,
    dto: CreateLinkedFileDto,
    userId?: string,
  ): Promise<LinkedFileResponseDto> {
    const filename = dto.name.trim();
    if (!filename) {
      throw new BadRequestException('Linked file name is required');
    }
    if (
      filename.includes('..') ||
      filename.includes('/') ||
      filename.includes('\\') ||
      /[\x00-\x1f\x7f]/.test(filename)
    ) {
      throw new BadRequestException('Invalid linked file name');
    }

    const linkedFileId = randomUUID();
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    const isText = TEXT_EXTENSIONS.has(ext);

    let docId: string | null = null;
    let fileId: string | null = null;
    let nodeId: string | null = null;

    if (
      dto.provider === 'url' ||
      ((dto.provider === 'github' || dto.provider === 'dropbox') && dto.url)
    ) {
      if (!dto.url) {
        throw new BadRequestException('URL is required for URL provider');
      }

      try {
        const download = await this.downloadUrl(dto.url);
        const saga = new SagaRunner();

        if (isText) {
          saga
            .addStep({
              name: 'create-linked-doc',
              execute: async () => {
                const textContent = download.buffer.toString('utf8');
                const doc = await this.docstoreService!.createDoc(projectId, {
                  path: filename,
                  text: textContent,
                });
                docId = doc._id;
                return doc._id;
              },
              compensate: async (createdDocId) => {
                if (createdDocId && this.docstoreService) {
                  await this.docstoreService
                    .deleteDoc(projectId, createdDocId, { soft: false })
                    .catch((compErr) => {
                      this.logger.warn(
                        `Compensation failed deleting orphan doc ${createdDocId}: ${String(compErr)}`,
                      );
                    });
                }
              },
            })
            .addStep({
              name: 'create-linked-doc-node',
              execute: async () => {
                const node = await this.structureService!.createNode(projectId, {
                  name: filename,
                  type: 'DOC',
                  parentId: dto.parentFolderId || null,
                  docId: docId!,
                });
                nodeId = node.id;
                return node.id;
              },
              compensate: async (createdNodeId) => {
                if (createdNodeId && this.structureService) {
                  await this.structureService
                    .deleteNode(projectId, createdNodeId)
                    .catch((compErr) => {
                      this.logger.warn(
                        `Compensation failed deleting orphan node ${createdNodeId}: ${String(compErr)}`,
                      );
                    });
                }
              },
            });
        } else {
          let targetRelativePath = filename;
          if (
            dto.parentFolderId &&
            typeof this.structureService?.getNodeById === 'function'
          ) {
            const parentFolder = await Promise.resolve(
              this.structureService.getNodeById(projectId, dto.parentFolderId),
            ).catch(() => null);
            if (parentFolder?.path && parentFolder.path !== '/') {
              targetRelativePath = `${parentFolder.path.replace(/^\/+/, '')}/${filename}`;
            }
          }
          saga
            .addStep({
              name: 'upload-linked-binary',
              execute: async () => {
                const uploadedFile =
                  await this.filestoreService!.uploadFileFromBuffer(
                    projectId,
                    targetRelativePath,
                    download.buffer,
                    download.mimeType,
                  );
                fileId = uploadedFile.id;
                return uploadedFile.id;
              },
              compensate: async (createdFileId) => {
                if (createdFileId && this.filestoreService) {
                  await this.filestoreService
                    .deleteFile(projectId, createdFileId, true)
                    .catch((compErr) => {
                      this.logger.warn(
                        `Compensation failed deleting orphan file ${createdFileId}: ${String(compErr)}`,
                      );
                    });
                }
              },
            })
            .addStep({
              name: 'create-linked-file-node',
              execute: async () => {
                const node = await this.structureService!.createNode(projectId, {
                  name: filename,
                  type: 'FILE',
                  parentId: dto.parentFolderId || null,
                  fileId: fileId!,
                });
                nodeId = node.id;
                return node.id;
              },
              compensate: async (createdNodeId) => {
                if (createdNodeId && this.structureService) {
                  await this.structureService
                    .deleteNode(projectId, createdNodeId)
                    .catch((compErr) => {
                      this.logger.warn(
                        `Compensation failed deleting orphan node ${createdNodeId}: ${String(compErr)}`,
                      );
                    });
                }
              },
            });
        }

        let createdEntity!: LinkedFileEntity;
        saga.addStep({
          name: 'save-linked-file-entity',
          execute: async () => {
            createdEntity = new LinkedFileEntity({
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
            await this.repository.save(createdEntity);
            return createdEntity.id;
          },
          compensate: async (savedId) => {
            if (savedId) {
              await this.repository
                .delete(projectId, savedId)
                .catch(() => undefined);
            }
          },
        });

        await saga.run();

        this.broadcastFileTreeChange(projectId, {
          action: 'linked-file-created',
          node: { id: nodeId, name: filename, linkedFileId },
        });

        return this.mapToDto(createdEntity);
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
        const saga = new SagaRunner();
        let preExistingNodeId: string | undefined;
        let createdEntity!: LinkedFileEntity;

        saga
          .addStep({
            name: 'sync-library-collection',
            execute: async () => {
              const beforeNode = await this.structureService
                ?.getNodeByPath(projectId, filename)
                .catch(() => null);
              preExistingNodeId = beforeNode?.id;

              await this.citationsService!.syncLibraryCollection(
                projectId,
                userId || 'anonymous',
                {
                  collectionId: dto.collectionId!,
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
              return { nodeId, docId };
            },
            compensate: async (synced) => {
              if (
                synced?.nodeId &&
                synced.nodeId !== preExistingNodeId &&
                this.structureService
              ) {
                await this.structureService
                  .deleteNode(projectId, synced.nodeId)
                  .catch(() => undefined);
              }
              if (
                synced?.docId &&
                synced?.nodeId !== preExistingNodeId &&
                this.docstoreService
              ) {
                await this.docstoreService
                  .deleteDoc(projectId, synced.docId, { soft: false })
                  .catch(() => undefined);
              }
            },
          })
          .addStep({
            name: 'save-linked-file-entity',
            execute: async () => {
              createdEntity = new LinkedFileEntity({
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
              await this.repository.save(createdEntity);
              return createdEntity.id;
            },
            compensate: async (savedId) => {
              if (savedId) {
                await this.repository
                  .delete(projectId, savedId)
                  .catch(() => undefined);
              }
            },
          });

        await saga.run();

        this.broadcastFileTreeChange(projectId, {
          action: 'linked-file-created',
          node: { id: nodeId, name: filename, linkedFileId },
        });

        return this.mapToDto(createdEntity);
      } catch (err: unknown) {
        this.logger.error(
          `Failed to link library collection ${dto.collectionId}: ${(err as Error)?.message}`,
        );
        throw new BadRequestException(
          `Failed to link reference collection: ${(err as Error)?.message}`,
        );
      }
    }

    throw new BadRequestException(
      `Unsupported linked file provider "${dto.provider}" or missing required provider configuration`,
    );
  }

  public async refresh(
    projectId: string,
    fileIdOrLinkedFileId: string,
    userId?: string,
  ): Promise<LinkedFileResponseDto> {
    let linkedFile = await this.repository.findById(
      projectId,
      fileIdOrLinkedFileId,
    );
    if (!linkedFile) {
      linkedFile = await this.repository.findByNodeId(
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
      if (
        (linkedFile.provider === 'url' ||
          linkedFile.provider === 'github' ||
          linkedFile.provider === 'dropbox') &&
        linkedFile.url
      ) {
        const download = await this.downloadUrl(linkedFile.url);

        if (linkedFile.docId) {
          await this.liveCollab
            ?.flushDocs(projectId, [linkedFile.docId])
            .catch(() => []);
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

          if (this.domainEventBus) {
            await this.domainEventBus.publish({
              type: 'manuscript.document.mutated',
              projectId,
              docId: linkedFile.docId,
              lines,
              version: nextVersion,
              source: 'linked-files',
              occurredAt: Date.now(),
            });
          } else {
            await this.liveCollab
              ?.applyExternalText(projectId, linkedFile.docId, textContent)
              .catch((err) => {
                this.logger.warn(
                  `Failed to sync linked-file refresh to live session ${projectId}:${linkedFile.docId}: ${String(err)}`,
                );
              });
          }

          this.eventEmitter?.emit('manuscripts.project.event', {
            projectId,
            event: 'doc:content-updated',
            payload: {
              docId: linkedFile.docId,
            },
          });
        } else if (linkedFile.fileId) {
          const previousFileId = linkedFile.fileId;
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
          if (previousFileId && previousFileId !== newFile.id) {
            await this.filestoreService
              ?.deleteFile(projectId, previousFileId, true)
              .catch((err) => {
                this.logger.warn(
                  `Failed to delete superseded linked file asset ${previousFileId}: ${String(err)}`,
                );
              });
          }
        }
      } else if (
        (linkedFile.provider === 'zotero' ||
          linkedFile.provider === 'mendeley') &&
        linkedFile.collectionId
      ) {
        let resolvedBibPath = linkedFile.name;
        if (
          linkedFile.nodeId &&
          typeof this.structureService?.getNodeById === 'function'
        ) {
          const currentNode = await Promise.resolve(
            this.structureService.getNodeById(projectId, linkedFile.nodeId),
          ).catch(() => null);
          if (currentNode?.path) {
            resolvedBibPath = currentNode.path.replace(/^\/+/, '');
            linkedFile.name = currentNode.name || resolvedBibPath;
          }
        }
        await this.citationsService!.syncLibraryCollection(
          projectId,
          userId || 'anonymous',
          {
            collectionId: linkedFile.collectionId,
            targetFilename: resolvedBibPath,
          },
        );

        if (!linkedFile.docId && this.structureService) {
          const existingNode = await this.structureService
            .getNodeByPath(projectId, linkedFile.name)
            .catch(() => null);
          if (existingNode) {
            linkedFile.nodeId = existingNode.id;
            linkedFile.docId = existingNode.docId;
          }
        }

        if (linkedFile.docId) {
          this.eventEmitter?.emit('manuscripts.project.event', {
            projectId,
            event: 'doc:content-updated',
            payload: {
              docId: linkedFile.docId,
            },
          });
        }
      }

      linkedFile.markSynced(
        linkedFile.nodeId ?? undefined,
        linkedFile.docId ?? undefined,
        linkedFile.fileId ?? undefined,
      );
      await this.repository.save(linkedFile);

      this.broadcastFileTreeChange(projectId, {
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
      await this.repository.save(linkedFile);
      this.logger.warn(
        `Failed to refresh linked file ${linkedFile.id}: ${errorMessage}`,
      );
      throw new BadRequestException(`Refresh failed: ${errorMessage}`);
    }
  }

  public async list(projectId: string): Promise<LinkedFileResponseDto[]> {
    const entities = await this.repository.findByProject(projectId);
    return entities.map((e) => this.mapToDto(e));
  }

  public async delete(
    projectId: string,
    id: string,
    deleteNode = false,
  ): Promise<void> {
    const linkedFile = await this.repository.findById(projectId, id);
    if (!linkedFile) {
      throw new NotFoundException(`Linked file "${id}" not found`);
    }

    if (deleteNode && linkedFile.nodeId) {
      await this.structureService
        ?.deleteNode(projectId, linkedFile.nodeId)
        .catch((err) => {
          this.logger.warn(
            `Failed to delete structure node ${linkedFile.nodeId} for linked file ${id}: ${String(err)}`,
          );
        });
    }

    await this.repository.delete(projectId, id);

    this.broadcastFileTreeChange(projectId, {
      action: 'linked-file-deleted',
      node: { id: linkedFile.nodeId, linkedFileId: id },
    });
  }

  /**
   * Refreshes all linked files belonging to a specific project.
   */
  public async refreshAllByProject(
    projectId: string,
    userId?: string,
  ): Promise<{
    refreshedCount: number;
    total: number;
    succeeded: number;
    failed: number;
  }> {
    const items = await this.repository.findByProject(projectId);
    let succeeded = 0;
    let failed = 0;

    for (const item of items) {
      try {
        await this.refresh(projectId, item.id, userId);
        succeeded++;
      } catch (err: unknown) {
        failed++;
        this.logger.warn(
          `Refresh failed for linked file ${item.id} (${item.name}): ${(err as Error)?.message}`,
        );
      }
    }

    return {
      refreshedCount: succeeded,
      total: items.length,
      succeeded,
      failed,
    };
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
    const MAX_REDIRECTS = 5;
    let currentUrl = url;
    let response: Response | null = null;

    for (
      let redirectCount = 0;
      redirectCount <= MAX_REDIRECTS;
      redirectCount++
    ) {
      const validated = await assertSafeExternalUrl(currentUrl);
      const parsedUrl = validated.url ?? validated;

      response = await fetch(parsedUrl.toString(), {
        redirect: 'manual',
        signal: AbortSignal.timeout(30000),
        headers: {
          'User-Agent': 'Flux-Manuscript-LinkedFiles/1.0',
          Host: parsedUrl.host,
        },
      });

      if (response.url && response.url !== parsedUrl.toString()) {
        await assertSafeExternalUrl(response.url);
      }

      if (
        response.status === 301 ||
        response.status === 302 ||
        response.status === 303 ||
        response.status === 307 ||
        response.status === 308
      ) {
        if (redirectCount >= MAX_REDIRECTS) {
          throw new BadRequestException(
            `Maximum redirect limit (${MAX_REDIRECTS}) exceeded`,
          );
        }
        const location = response.headers.get('location');
        if (!location) {
          throw new BadRequestException(
            `Redirect response HTTP ${response.status} missing Location header`,
          );
        }
        const resolvedRedirectUrl = new URL(
          location,
          parsedUrl.toString(),
        ).toString();
        await assertSafeExternalUrl(resolvedRedirectUrl);
        currentUrl = resolvedRedirectUrl;
        continue;
      }

      // Re-verify DNS resolution immediately after connection to mitigate DNS rebinding TOCTOU
      await assertSafeExternalUrl(parsedUrl.toString());

      break;
    }

    if (!response || !response.ok) {
      throw new BadRequestException(
        `Remote server returned HTTP ${response?.status ?? 0} ${response?.statusText ?? 'Unknown'}`,
      );
    }

    const contentLength = Number(response.headers.get('content-length') || '0');
    if (contentLength > this.MAX_DOWNLOAD_SIZE_BYTES) {
      throw new PayloadTooLargeException(
        `File exceeds maximum permitted size of 50MB (${contentLength} bytes)`,
      );
    }

    const mimeType =
      response.headers.get('content-type') || 'application/octet-stream';

    let buffer: Buffer;
    if (response.body && typeof response.body.getReader === 'function') {
      const reader = response.body.getReader();
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            totalBytes += value.byteLength;
            if (totalBytes > this.MAX_DOWNLOAD_SIZE_BYTES) {
              await reader.cancel().catch(() => {});
              throw new PayloadTooLargeException(
                `File exceeds maximum permitted size of 50MB`,
              );
            }
            chunks.push(Buffer.from(value));
          }
        }
      } finally {
        reader.releaseLock();
      }
      buffer = Buffer.concat(chunks, totalBytes);
    } else {
      const arrayBuf = await response.arrayBuffer();
      buffer = Buffer.from(arrayBuf);
      if (buffer.length > this.MAX_DOWNLOAD_SIZE_BYTES) {
        throw new PayloadTooLargeException(
          `File exceeds maximum permitted size of 50MB`,
        );
      }
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
