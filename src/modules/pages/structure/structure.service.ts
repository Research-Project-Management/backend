import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import {
  IStructureRepository,
  ManuscriptNodeEntity,
  NodePathVo,
  FileTreeBuilder,
  StructureError,
  DuplicateNodePathError,
  NodeNotFoundError,
  RootDocNotFoundError,
  LatexOutlineExtractor,
  LatexOutlineEntryDto,
} from './domain';
import {
  CreateNodeDto,
  MoveNodeDto,
  RenameNodeDto,
  TreeNodeDto,
} from './dto/node.dto';
import {
  WorkspaceFile,
  CompilationPayload,
  LIVE_COLLABORATION_PORT,
  LiveCollaborationPort,
  ManuscriptDomainEventBus,
} from '@/modules/pages/core';
import { DocstoreService } from '@/modules/pages/docstore/docstore.service';
import { FilestoreService } from '@/modules/pages/filestore/filestore.service';
import { BibtexParser } from '@/modules/pages/citations/domain';
import { RealtimeFacade } from '@/modules/realtime/realtime.facade';
import { StructureRepository } from './structure.repository';

export type { CompilationPayload };

export interface ProjectSymbolLabelDto {
  key: string;
  file: string;
  line: number;
  context?: string;
}

export interface ProjectSymbolCitationDto {
  key: string;
  type: string;
  title?: string;
  author?: string;
  year?: string;
  journal?: string;
  booktitle?: string;
  publisher?: string;
  doi?: string;
  url?: string;
  abstract?: string;
  volume?: string;
  number?: string;
  pages?: string;
  file: string;
  line: number;
  raw?: string;
}

export interface ProjectSymbolCommandDto {
  name: string;
  argCount?: number;
  hasDefault?: boolean;
  defaultValue?: string;
  expansion?: string;
  file: string;
  line: number;
  signature: string;
}

export interface ProjectSymbolEnvironmentDto {
  name: string;
  argCount?: number;
  file: string;
  line: number;
}

export interface ProjectSymbolPackageDto {
  name: string;
  options?: string;
  file: string;
  line: number;
}

export interface ProjectSymbolOutlineDto {
  title: string;
  level: number;
  levelName: string;
  file: string;
  line: number;
  from: number;
  children?: ProjectSymbolOutlineDto[];
}

export interface ProjectSymbolsResponseDto {
  rootDocPath: string | null;
  labels: ProjectSymbolLabelDto[];
  citations: ProjectSymbolCitationDto[];
  customCommands: ProjectSymbolCommandDto[];
  customEnvironments: ProjectSymbolEnvironmentDto[];
  packages: ProjectSymbolPackageDto[];
  bibliographies: string[];
  includedFiles: string[];
  imageFiles: string[];
  files: string[];
  images: string[];
  outline: ProjectSymbolOutlineDto[];
}

interface CachedDocSymbols {
  readonly labels: ProjectSymbolLabelDto[];
  readonly citations: ProjectSymbolCitationDto[];
  readonly customCommands: ProjectSymbolCommandDto[];
  readonly customEnvironments: ProjectSymbolEnvironmentDto[];
  readonly packages: ProjectSymbolPackageDto[];
  readonly bibliographies: string[];
  readonly includedFiles: string[];
  readonly outline: ProjectSymbolOutlineDto[];
}

@Injectable()
export class StructureService {
  private static readonly MAX_DOC_SYMBOL_CACHE_ENTRIES = 2000;
  private readonly logger = new Logger(StructureService.name);
  private readonly domainEventBus: ManuscriptDomainEventBus;
  private readonly docSymbolsCache = new Map<string, CachedDocSymbols>();

  constructor(
    @Inject(IStructureRepository)
    private readonly repository: IStructureRepository,
    @Optional() private readonly realtimeService?: RealtimeFacade,
    @Optional() private readonly filestoreService?: FilestoreService,
    @Optional() private readonly docstoreService?: DocstoreService,
    @Optional()
    @Inject(ManuscriptDomainEventBus)
    domainEventBus?: ManuscriptDomainEventBus | unknown,
    @Optional()
    legacyEventBus?: ManuscriptDomainEventBus,
    @Optional()
    @Inject(LIVE_COLLABORATION_PORT)
    private readonly injectedLiveCollab?: LiveCollaborationPort,
  ) {
    const resolvedBus =
      legacyEventBus ??
      (domainEventBus &&
      typeof (domainEventBus as ManuscriptDomainEventBus).publish === 'function'
        ? (domainEventBus as ManuscriptDomainEventBus)
        : undefined);
    this.domainEventBus =
      resolvedBus ?? new ManuscriptDomainEventBus(this.injectedLiveCollab);
  }

  public async getFileTree(projectId: string): Promise<TreeNodeDto[]> {
    const nodes = await this.repository.getAllNodes(projectId);
    return FileTreeBuilder.buildTreeHierarchy(nodes);
  }

  public async getAllNodes(
    projectId: string,
    parentId?: string,
  ): Promise<ManuscriptNodeEntity[]> {
    const nodes = await this.repository.getAllNodes(projectId);
    const trimmedParentId = parentId?.trim();
    if (!trimmedParentId) {
      return nodes;
    }
    if (trimmedParentId === 'root' || trimmedParentId === 'null') {
      return nodes.filter((n) => n.parentId === null);
    }
    const isKnownFolder = nodes.some(
      (n) => n.id === trimmedParentId && n.isFolder(),
    );
    if (isKnownFolder) {
      return nodes.filter((n) => n.parentId === trimmedParentId);
    }
    return nodes;
  }

  public async getNodeById(
    projectId: string,
    nodeId: string,
  ): Promise<ManuscriptNodeEntity | null> {
    return await this.repository.findById(projectId, nodeId);
  }

  public async getNodeByPath(
    projectId: string,
    path: string,
  ): Promise<ManuscriptNodeEntity | null> {
    return await this.repository.findByPath(projectId, path);
  }

  private async resolveOrMaterializeParentFolder(
    projectId: string,
    options: {
      parentId?: string | null;
      explicitPath?: string;
      leafName: string;
      parentRoleLabel?: string;
    },
  ): Promise<{ parentNode: ManuscriptNodeEntity | null; computedPath: string }> {
    const roleLabel = options.parentRoleLabel || 'Parent node';
    if (options.parentId) {
      const parentNode = await this.repository.findById(
        projectId,
        options.parentId,
      );
      if (!parentNode) {
        throw new NodeNotFoundError(options.parentId);
      }
      parentNode.assertCanContainChildren(roleLabel);
      return {
        parentNode,
        computedPath: NodePathVo.join(parentNode.path, options.leafName),
      };
    }

    if (options.explicitPath) {
      const parsed = NodePathVo.parse(options.explicitPath);
      if (parsed.parentPath === '/') {
        return { parentNode: null, computedPath: parsed.normalizedPath };
      }
      const existingParent = await this.repository.findByPath(
        projectId,
        parsed.parentPath,
      );
      if (existingParent) {
        existingParent.assertCanContainChildren(roleLabel);
        return {
          parentNode: existingParent,
          computedPath: parsed.normalizedPath,
        };
      }
      const createdParent = await this.mkdirpInternal(
        projectId,
        parsed.parentPath,
      );
      return {
        parentNode: createdParent,
        computedPath: parsed.normalizedPath,
      };
    }

    return {
      parentNode: null,
      computedPath: NodePathVo.join('/', options.leafName),
    };
  }

  public async createNode(
    projectId: string,
    dto: CreateNodeDto,
  ): Promise<ManuscriptNodeEntity> {
    const rawTarget =
      dto.path && dto.path.trim() !== '' ? dto.path : dto.name;
    const parsedTarget = NodePathVo.parse(rawTarget);
    const leafName =
      parsedTarget.leafName ||
      NodePathVo.parse(dto.name).leafName;
    NodePathVo.validateFilename(leafName);

    const currentCount = await this.repository.countNodes(projectId);
    FileTreeBuilder.validateProjectFileLimit(currentCount);

    const explicitPath =
      dto.path && dto.path.trim() !== ''
        ? dto.path
        : !dto.parentId && parsedTarget.folderSegments.length > 0
          ? parsedTarget.normalizedPath
          : undefined;

    const { parentNode, computedPath } =
      await this.resolveOrMaterializeParentFolder(projectId, {
        parentId: dto.parentId,
        explicitPath,
        leafName,
        parentRoleLabel: 'Parent node',
      });

    const existing = await this.repository.findByPath(projectId, computedPath);
    if (existing) {
      if (dto.type === 'FILE' && dto.fileId && existing.fileId === dto.fileId) {
        this.realtimeService?.broadcastFileTreeChange(projectId, {
          action: 'create',
          node: existing,
        });
        return existing;
      }
      throw new DuplicateNodePathError(computedPath);
    }

    if (dto.type === 'FILE' && dto.fileId && this.repository.findByFileId) {
      const preSyncedNode = await this.repository.findByFileId(projectId, dto.fileId);
      if (preSyncedNode) {
        await this.repository.moveSubtree(
          projectId,
          preSyncedNode.path,
          computedPath,
          parentNode ? parentNode.id : null,
        );
        const movedNode =
          (await this.repository.findById(projectId, preSyncedNode.id)) ??
          preSyncedNode;
        this.realtimeService?.broadcastFileTreeChange(projectId, {
          action: 'create',
          node: movedNode,
        });
        return movedNode;
      }
    }

    let resolvedDocId = dto.docId;
    let resolvedSizeBytes: number | undefined;
    let resolvedHash: string | null | undefined;

    if (resolvedDocId && this.repository.docExistsInProject) {
      const exists = await this.repository.docExistsInProject(
        projectId,
        resolvedDocId,
      );
      if (!exists) {
        throw new NotFoundException({
          statusCode: 404,
          code: 'RESOURCE_NOT_FOUND',
          message: 'Document not found in project',
        });
      }
    } else if (dto.type === 'DOC' && !resolvedDocId && this.docstoreService) {
      const initialLines =
        dto.content && dto.content.length > 0
          ? dto.content.split(/\r?\n/)
          : [''];
      const createdDoc = await this.docstoreService.createDoc(projectId, {
        path: NodePathVo.toRelative(computedPath),
        lines: initialLines,
      });
      resolvedDocId = createdDoc.id;
      resolvedSizeBytes = createdDoc.sizeBytes;
      resolvedHash = createdDoc.hash;
    }

    if (dto.fileId && this.repository.fileExistsInProject) {
      const exists = await this.repository.fileExistsInProject(projectId, dto.fileId);
      if (!exists) {
        throw new NotFoundException({
          statusCode: 404,
          code: 'RESOURCE_NOT_FOUND',
          message: 'File asset not found in project',
        });
      }
    }

    try {
      const shouldSetRootDoc = Boolean(dto.isRootDoc && dto.type === 'DOC');
      let node = await this.repository.createNode({
        projectId,
        parentId: parentNode ? parentNode.id : null,
        type: dto.type,
        name: leafName,
        path: computedPath,
        docId: resolvedDocId,
        fileId: dto.fileId,
        isRootDoc: shouldSetRootDoc,
        ...(resolvedSizeBytes !== undefined
          ? { sizeBytes: resolvedSizeBytes }
          : {}),
        ...(resolvedHash !== undefined ? { hash: resolvedHash } : {}),
      });

      if (shouldSetRootDoc) {
        try {
          await this.repository.setRootDoc(projectId, node.id);
          node.markAsRootDoc(true);
        } catch (rootErr: unknown) {
          this.logger.warn(
            `Failed to set root doc for newly created node ${node.id} in project ${projectId}: ${String(rootErr)}`,
          );
        }
      }

      this.realtimeService?.broadcastFileTreeChange(projectId, {
        action: 'create',
        node,
      });
      return node;
    } catch (err: unknown) {
      if (resolvedDocId && !dto.docId) {
        try {
          if (this.docstoreService) {
            if (typeof this.docstoreService.deleteDoc === 'function') {
              await this.docstoreService.deleteDoc(projectId, resolvedDocId, {
                soft: false,
              });
            } else {
              await this.docstoreService.patchDoc(projectId, resolvedDocId, {
                deleted: true,
                deletedAt: new Date().toISOString(),
              });
            }
          }
        } catch (rollbackErr) {
          this.logger.warn(
            `Failed to delete orphan backing doc ${resolvedDocId} after createNode error: ${String(rollbackErr)}`,
          );
        }
      }
      const errObj = err as { code?: string; message?: string } | null;
      if (errObj?.code === 'P2002' || errObj?.message?.includes('P2002')) {
        throw new DuplicateNodePathError(computedPath);
      }
      throw err;
    }
  }

  private async mkdirpInternal(
    projectId: string,
    dirPath: string,
  ): Promise<ManuscriptNodeEntity> {
    const parsed = NodePathVo.parse(dirPath);
    if (parsed.normalizedPath === '/') {
      throw new StructureError('Cannot mkdirp root directory');
    }

    const segmentEntries: Array<{ segment: string; path: string }> = [];
    let runningPath = '';
    for (const segment of parsed.segments) {
      runningPath = NodePathVo.join(runningPath, segment);
      segmentEntries.push({ segment, path: runningPath });
    }

    const existingNodes = await Promise.all(
      segmentEntries.map((entry) =>
        this.repository.findByPath(projectId, entry.path),
      ),
    );

    let parentNode: ManuscriptNodeEntity | null = null;

    for (let i = 0; i < segmentEntries.length; i++) {
      const { segment, path: currentPath } = segmentEntries[i];
      let found = existingNodes[i];

      if (found && !found.isFolder()) {
        throw new DuplicateNodePathError(currentPath);
      }

      if (!found) {
        try {
          found = await this.repository.createNode({
            projectId,
            parentId: parentNode ? parentNode.id : null,
            type: 'FOLDER',
            name: segment,
            path: currentPath,
          });
        } catch (err: unknown) {
          const errObj = err as { code?: string; message?: string } | null;
          if (
            errObj?.code === 'P2002' ||
            errObj?.message?.includes('P2002') ||
            err instanceof DuplicateNodePathError
          ) {
            found = await this.repository.findByPath(projectId, currentPath);
            if (!found || !found.isFolder()) {
              throw new DuplicateNodePathError(currentPath);
            }
          } else {
            throw err;
          }
        }
      }

      parentNode = found;
    }

    return parentNode!;
  }

  public async mkdirp(
    projectId: string,
    dirPath: string,
  ): Promise<ManuscriptNodeEntity> {
    const node = await this.mkdirpInternal(projectId, dirPath);
    this.realtimeService?.broadcastFileTreeChange(projectId, {
      action: 'mkdirp',
      node,
    });
    return node;
  }

  public async moveNode(
    projectId: string,
    nodeId: string,
    dto: MoveNodeDto,
  ): Promise<ManuscriptNodeEntity> {
    const targetNode = await this.repository.findById(projectId, nodeId);
    if (!targetNode) {
      throw new NodeNotFoundError(nodeId);
    }
    targetNode.assertMutableTarget();

    const targetParentId =
      dto.destParentId !== undefined ? dto.destParentId : dto.parentId;
    const { parentNode: destParent, computedPath: destPath } =
      await this.resolveOrMaterializeParentFolder(projectId, {
        parentId: targetParentId,
        explicitPath: targetParentId ? undefined : dto.destPath,
        leafName: targetNode.name,
        parentRoleLabel: 'Destination parent',
      });
    const newParentId = destParent ? destParent.id : null;

    targetNode.validateMoveTo(destPath);

    const existing = await this.repository.findByPath(projectId, destPath);
    if (existing && existing.id !== targetNode.id) {
      throw new DuplicateNodePathError(destPath);
    }

    const oldPath = targetNode.path;
    await this.repository.moveSubtree(projectId, oldPath, destPath, newParentId);

    const node = (await this.repository.findById(projectId, targetNode.id))!;

    this.realtimeService?.broadcastFileTreeChange(projectId, {
      action: 'move',
      node,
    });
    return node;
  }

  public async renameNode(
    projectId: string,
    nodeId: string,
    dto: RenameNodeDto,
  ): Promise<ManuscriptNodeEntity> {
    const existingNode = await this.repository.findById(projectId, nodeId);
    if (!existingNode) {
      throw new NodeNotFoundError(nodeId);
    }
    existingNode.assertMutableTarget();

    // If caller passes a relative or absolute path (e.g. "sections/new_name.tex" or "/new_name.tex"),
    // extract the leaf name when the parent folder is unchanged, or delegate to move+rename when the parent folder changes.
    const rawInput = (dto.name || '').trim();
    if (rawInput.includes('/') || rawInput.includes('\\')) {
      const parsed = NodePathVo.parse(rawInput);
      const currentParentPath = NodePathVo.dirname(existingNode.path);
      if (parsed.parentPath !== currentParentPath) {
        const { parentNode: destParent, computedPath: destPath } =
          await this.resolveOrMaterializeParentFolder(projectId, {
            explicitPath: parsed.normalizedPath,
            leafName: parsed.leafName,
            parentRoleLabel: 'Destination parent',
          });
        existingNode.validateMoveTo(destPath);
        const conflict = await this.repository.findByPath(projectId, destPath);
        if (conflict && conflict.id !== existingNode.id) {
          throw new DuplicateNodePathError(destPath);
        }
        await this.repository.moveSubtree(
          projectId,
          existingNode.path,
          destPath,
          destParent ? destParent.id : null,
        );
        const movedAndRenamed = (await this.repository.findById(
          projectId,
          existingNode.id,
        ))!;
        this.realtimeService?.broadcastFileTreeChange(projectId, {
          action: 'rename',
          node: movedAndRenamed,
        });
        return movedAndRenamed;
      }
      dto = { ...dto, name: parsed.leafName };
    }

    const newName = dto.name;
    NodePathVo.validateFilename(newName);

    let node: ManuscriptNodeEntity;
    if (existingNode.name === newName) {
      node = existingNode;
    } else {
      const { oldPath, newPath } = existingNode.renameTo(newName);

      const conflict = await this.repository.findByPath(projectId, newPath);
      if (conflict && conflict.id !== existingNode.id) {
        throw new DuplicateNodePathError(newPath);
      }

      if (existingNode.isFolder()) {
        await this.repository.moveSubtree(
          projectId,
          oldPath,
          newPath,
          existingNode.parentId,
        );
        node = (await this.repository.findById(projectId, existingNode.id))!;
      } else {
        node = await this.repository.renameNode(
          projectId,
          existingNode.id,
          newName,
          newPath,
        );
      }
    }

    this.realtimeService?.broadcastFileTreeChange(projectId, {
      action: 'rename',
      node,
    });
    return node;
  }

  public async deleteNode(
    projectId: string,
    nodeId: string,
  ): Promise<ManuscriptNodeEntity[]> {
    const node = await this.repository.findById(projectId, nodeId);
    if (!node) {
      throw new NodeNotFoundError(nodeId);
    }
    node.assertMutableTarget();

    const deletedNodes = await this.repository.deleteSubtree(projectId, node.path);

    const docIds = Array.from(
      new Set(
        deletedNodes
          .map((n) => n.docId)
          .filter(
            (id): id is string => typeof id === 'string' && id.length > 0,
          ),
      ),
    );
    const fileIds = Array.from(
      new Set(
        deletedNodes
          .map((n) => n.fileId)
          .filter(
            (id): id is string => typeof id === 'string' && id.length > 0,
          ),
      ),
    );
    const hadRootDoc = deletedNodes.some((n) => n.isRootDoc);

    // Reclaim Space StorageQuota and release StorageBlob CAS references for deleted binary files
    if (fileIds.length > 0 && this.filestoreService?.reclaimDeletedFilesQuotaAndBlobs) {
      await this.filestoreService
        .reclaimDeletedFilesQuotaAndBlobs(projectId, fileIds, deletedNodes)
        .catch((err: unknown) => {
          this.logger.warn(
            `Failed to reclaim storage quota/blobs for deleted subtree in ${projectId}: ${(err as Error)?.message}`,
          );
        });
    }

    await this.domainEventBus.publish({
      type: 'manuscript.nodes.deleted',
      projectId,
      deletedDocIds: docIds,
      deletedFileIds: fileIds,
      hadRootDoc,
      occurredAt: Date.now(),
    });

    if (hadRootDoc) {
      await this.repository.unsetRootDoc(projectId);
      const docContentsMap = new Map<string, string[]>();
      if (this.docstoreService) {
        try {
          const allDocs = await this.docstoreService.getAllDocs(projectId);
          for (const d of allDocs) {
            const dId = d.id || d._id;
            if (dId && Array.isArray(d.lines)) {
              docContentsMap.set(dId, d.lines);
            }
          }
        } catch {
          // non-blocking fallback to filename-based root detection
        }
      }
      await this.autoDetectRootDoc(projectId, docContentsMap).catch(() => null);
    }

    this.realtimeService?.broadcastFileTreeChange(projectId, {
      action: 'delete',
      node: { id: nodeId },
    });
    return deletedNodes;
  }

  public async getRootDoc(
    projectId: string,
  ): Promise<ManuscriptNodeEntity | null> {
    return await this.repository.getRootDoc(projectId);
  }

  public async setRootDoc(
    projectId: string,
    nodeId: string,
  ): Promise<ManuscriptNodeEntity> {
    const found = await this.repository.findById(projectId, nodeId);
    if (!found) {
      throw new NodeNotFoundError(nodeId);
    }
    found.assertCanBeRootDoc();

    await this.repository.setRootDoc(projectId, found.id);
    found.markAsRootDoc(true);
    const node =
      (await this.repository.findById(projectId, found.id)) ?? found;

    this.realtimeService?.broadcastFileTreeChange(projectId, {
      action: 'set-root',
      node,
    });
    return node;
  }

  public async autoDetectRootDoc(
    projectId: string,
    docContents: Map<string, string[]>,
    existingNodes?: ManuscriptNodeEntity[],
  ): Promise<ManuscriptNodeEntity | null> {
    const existing = existingNodes
      ? (existingNodes.find((n) => n.isRootDoc) ?? null)
      : await this.repository.getRootDoc(projectId);
    if (existing) {
      return existing;
    }

    const allNodes = existingNodes ?? (await this.repository.getAllNodes(projectId));
    const detected = FileTreeBuilder.detectRootDoc(allNodes, docContents);

    if (detected) {
      await this.repository.setRootDoc(projectId, detected.id);
      this.logger.log(
        `Auto-detected root document '${detected.path}' for project ${projectId}`,
      );

      return (await this.repository.findById(projectId, detected.id)) ?? detected;
    }

    return null;
  }

  public async buildCompilerPayload(
    projectId: string,
    docContentsMap: Map<string, { lines: string[]; hash?: string | null }>,
  ): Promise<CompilationPayload> {
    const nodes = await this.repository.getAllNodes(projectId);

    let rootNode = nodes.find((n) => n.isRootDoc) ?? null;
    if (!rootNode) {
      const linesMap = new Map<string, string[]>();
      for (const [id, val] of docContentsMap.entries()) {
        linesMap.set(id, val.lines);
      }
      rootNode = await this.autoDetectRootDoc(projectId, linesMap, nodes);
    }

    if (!rootNode) {
      throw new RootDocNotFoundError(projectId);
    }

    const nonFolderNodes = nodes.filter((n) => !n.isFolder());
    const files: WorkspaceFile[] = new Array(nonFolderNodes.length);
    const STREAM_CONCURRENCY = 8;

    for (let i = 0; i < nonFolderNodes.length; i += STREAM_CONCURRENCY) {
      const batch = nonFolderNodes.slice(i, i + STREAM_CONCURRENCY);
      await Promise.all(
        batch.map(async (node, idx) => {
          const targetIndex = i + idx;
          const relativePath = FileTreeBuilder.toRelativeCompilerPath(
            node.path,
          );

          if (node.isDoc()) {
            const docData =
              docContentsMap.get(node.id) ||
              (node.docId ? docContentsMap.get(node.docId) : undefined);
            const content = docData ? docData.lines.join('\n') : '';
            const hash = docData?.hash || node.hash || undefined;

            files[targetIndex] = {
              path: relativePath,
              content,
              hash,
            };
          } else {
            let binaryContent: Buffer | string = '';
            if (node.fileId && this.filestoreService) {
              try {
                const { stream } = await this.filestoreService.openReadStream(
                  projectId,
                  node.fileId,
                );
                const chunks: Buffer[] = [];
                for await (const chunk of stream) {
                  chunks.push(
                    Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
                  );
                }
                binaryContent = Buffer.concat(chunks);
              } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                this.logger.warn(
                  `Failed to read binary file ${node.fileId} (${relativePath}) from filestore: ${msg}`,
                );
              }
            }

            files[targetIndex] = {
              path: relativePath,
              content: binaryContent,
              hash: node.hash || undefined,
            };
          }
        }),
      );
    }

    return {
      rootDocPath: FileTreeBuilder.toRelativeCompilerPath(rootNode.path),
      files: files.filter(Boolean),
    };
  }

  public async reorderNode(
    projectId: string,
    nodeId: string,
    sortOrder: number,
  ): Promise<void> {
    const existing = await this.repository.findById(projectId, nodeId);
    const targetId = existing ? existing.id : nodeId;
    await this.repository.updateSortOrder(projectId, targetId, sortOrder);
  }

  public async updateNodeFileId(
    projectId: string,
    nodeId: string,
    fileId: string,
    sizeBytes?: number,
    hash?: string | null,
  ): Promise<ManuscriptNodeEntity> {
    if (!this.repository.updateNodeFileId) {
      throw new StructureError(
        'updateNodeFileId is not supported by this repository',
      );
    }
    const node = await this.repository.updateNodeFileId(
      projectId,
      nodeId,
      fileId,
      sizeBytes,
      hash,
    );
    this.realtimeService?.broadcastFileTreeChange(projectId, {
      action: 'update',
      node,
    });
    return node;
  }

  private extractSingleDocSymbols(
    filePath: string,
    lines: string[],
    bibParser: BibtexParser,
  ): CachedDocSymbols {
    const lowerPath = filePath.toLowerCase();
    const docLabels: ProjectSymbolLabelDto[] = [];
    const docCitations: ProjectSymbolCitationDto[] = [];
    const docCommands: ProjectSymbolCommandDto[] = [];
    const docEnvs: ProjectSymbolEnvironmentDto[] = [];
    const docPackages: ProjectSymbolPackageDto[] = [];
    const docBibliographies: string[] = [];
    const docIncludedFiles: string[] = [];
    const docOutline: ProjectSymbolOutlineDto[] = [];

    const SECTION_LEVELS: Record<string, number> = {
      part: 0,
      chapter: 1,
      section: 2,
      subsection: 3,
      subsubsection: 4,
      paragraph: 5,
      subparagraph: 6,
    };

    if (lowerPath.endsWith('.bib')) {
      docBibliographies.push(filePath);
      const rawContent = lines.join('\n');
      const parsedEntries = bibParser.parse(rawContent);
      for (const entry of parsedEntries) {
        const json = entry.toJSON();
        docCitations.push({
          key: json.key,
          type: json.entryType,
          title: json.title,
          author: json.author,
          year: json.year,
          journal: json.journal,
          booktitle: json.fields?.booktitle,
          publisher: json.fields?.publisher,
          doi: json.doi,
          url: json.fields?.url,
          abstract: json.fields?.abstract,
          volume: json.fields?.volume,
          number: json.fields?.number,
          pages: json.fields?.pages,
          file: filePath,
          line: 1,
          raw: json.rawBibtex,
        });
      }
      return {
        labels: docLabels,
        citations: docCitations,
        customCommands: docCommands,
        customEnvironments: docEnvs,
        packages: docPackages,
        bibliographies: docBibliographies,
        includedFiles: docIncludedFiles,
        outline: docOutline,
      };
    }

    if (
      !lowerPath.endsWith('.tex') &&
      !lowerPath.endsWith('.sty') &&
      !lowerPath.endsWith('.cls') &&
      !lowerPath.endsWith('.ltx')
    ) {
      return {
        labels: docLabels,
        citations: docCitations,
        customCommands: docCommands,
        customEnvironments: docEnvs,
        packages: docPackages,
        bibliographies: docBibliographies,
        includedFiles: docIncludedFiles,
        outline: docOutline,
      };
    }

    let offset = 0;
    for (let i = 0; i < lines.length; i++) {
      const rawLine = lines[i] ?? '';
      const lineNum = i + 1;
      let cleanLine = rawLine;
      for (let c = 0; c < rawLine.length; c++) {
        if (rawLine[c] === '%' && (c === 0 || rawLine[c - 1] !== '\\')) {
          cleanLine = rawLine.slice(0, c);
          break;
        }
      }

      if (cleanLine.trim().length > 0) {
        const labelRe = /\\label\s*\{\s*([^}]+?)\s*\}/g;
        let m: RegExpExecArray | null;
        while ((m = labelRe.exec(cleanLine)) !== null) {
          const key = m[1].trim();
          if (key) {
            docLabels.push({
              key,
              file: filePath,
              line: lineNum,
              context: cleanLine.trim().slice(0, 120),
            });
          }
        }

        const cmdRe =
          /\\(?:newcommand|renewcommand|providecommand|DeclareRobustCommand)\*?\s*\{?\s*(\\[a-zA-Z@]+)\s*\}?(?:\s*\[(\d+)\])?(?:\s*\[([^\]]*)\])?/g;
        while ((m = cmdRe.exec(cleanLine)) !== null) {
          const name = m[1].trim();
          const argCount = m[2] ? parseInt(m[2], 10) : 0;
          const hasDefault = m[3] !== undefined;
          const defaultValue = m[3];
          const signature =
            argCount > 0
              ? `${name}${hasDefault ? `[${defaultValue}]` : ''}${'{...}'.repeat(Math.max(0, argCount - (hasDefault ? 1 : 0)))}`
              : name;
          docCommands.push({
            name,
            argCount,
            hasDefault,
            defaultValue,
            file: filePath,
            line: lineNum,
            signature,
          });
        }

        const mathOpRe =
          /\\DeclareMathOperator\*?\s*\{\s*(\\[a-zA-Z@]+)\s*\}\s*\{\s*([^}]*)\s*\}/g;
        while ((m = mathOpRe.exec(cleanLine)) !== null) {
          const name = m[1].trim();
          docCommands.push({
            name,
            argCount: 0,
            expansion: m[2]?.trim(),
            file: filePath,
            line: lineNum,
            signature: name,
          });
        }

        const defRe = /\\(?:g?def|edef|xdef)\s*(\\[a-zA-Z@]+)(?:#\d+)*/g;
        while ((m = defRe.exec(cleanLine)) !== null) {
          const name = m[1].trim();
          docCommands.push({
            name,
            argCount: 0,
            file: filePath,
            line: lineNum,
            signature: name,
          });
        }

        const envRe =
          /\\(?:newenvironment|renewenvironment)\*?\s*\{\s*([^}]+?)\s*\}(?:\s*\[(\d+)\])?/g;
        while ((m = envRe.exec(cleanLine)) !== null) {
          const name = m[1].trim();
          const argCount = m[2] ? parseInt(m[2], 10) : 0;
          docEnvs.push({
            name,
            argCount,
            file: filePath,
            line: lineNum,
          });
        }

        const pkgRe =
          /\\(?:usepackage|RequirePackage)\s*(?:\[([^\]]*)\])?\s*\{\s*([^}]+?)\s*\}/g;
        while ((m = pkgRe.exec(cleanLine)) !== null) {
          const options = m[1]?.trim();
          const pkgList = m[2]
            .split(',')
            .map((p) => p.trim())
            .filter(Boolean);
          for (const pkgName of pkgList) {
            docPackages.push({
              name: pkgName,
              options,
              file: filePath,
              line: lineNum,
            });
          }
        }

        const includeRe =
          /\\(?:input|include|subfile|includeonly)\s*\{\s*([^}]+?)\s*\}/g;
        while ((m = includeRe.exec(cleanLine)) !== null) {
          const rawInc = m[1].trim();
          if (rawInc) {
            docIncludedFiles.push(
              rawInc.endsWith('.tex') ? rawInc : `${rawInc}.tex`,
            );
          }
        }

        const bibCmdRe =
          /\\(?:bibliography|addbibresource|nobibliography)\s*(?:\[[^\]]*\])?\s*\{\s*([^}]+?)\s*\}/g;
        while ((m = bibCmdRe.exec(cleanLine)) !== null) {
          const bibTargets = m[1]
            .split(',')
            .map((b) => b.trim())
            .filter(Boolean);
          for (const b of bibTargets) {
            docBibliographies.push(b.endsWith('.bib') ? b : `${b}.bib`);
          }
        }

        const secRe =
          /\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?(?:\[[^\]]*\])?\{([^}]*)\}/g;
        while ((m = secRe.exec(cleanLine)) !== null) {
          const levelName = m[1];
          const title = m[2].trim();
          docOutline.push({
            title: title || levelName,
            level: SECTION_LEVELS[levelName] ?? 2,
            levelName,
            file: filePath,
            line: lineNum,
            from: offset + m.index,
          });
        }

        const bibitemRe = /\\bibitem\s*(?:\[[^\]]*\])?\s*\{\s*([^}]+?)\s*\}/g;
        while ((m = bibitemRe.exec(cleanLine)) !== null) {
          const key = m[1].trim();
          if (key) {
            docCitations.push({
              key,
              type: 'bibitem',
              title: key,
              file: filePath,
              line: lineNum,
            });
          }
        }
      }

      offset += rawLine.length + 1;
    }

    return {
      labels: docLabels,
      citations: docCitations,
      customCommands: docCommands,
      customEnvironments: docEnvs,
      packages: docPackages,
      bibliographies: docBibliographies,
      includedFiles: docIncludedFiles,
      outline: docOutline,
    };
  }

  public async getProjectSymbols(
    projectId: string,
  ): Promise<ProjectSymbolsResponseDto> {
    const { nodes, docsToScan, docHashByPath, rootDocPath } =
      await this.loadProjectDocsContext(projectId);

    const labelsMap = new Map<string, ProjectSymbolLabelDto>();
    const citationsMap = new Map<string, ProjectSymbolCitationDto>();
    const commandsMap = new Map<string, ProjectSymbolCommandDto>();
    const envsMap = new Map<string, ProjectSymbolEnvironmentDto>();
    const packagesMap = new Map<string, ProjectSymbolPackageDto>();
    const bibliographiesSet = new Set<string>();
    const includedFilesSet = new Set<string>();
    const imageFilesSet = new Set<string>();
    const allFilesSet = new Set<string>(docsToScan.keys());
    const outline: ProjectSymbolOutlineDto[] = [];

    const IMAGE_EXT_RE = /\.(png|jpe?g|pdf|eps|svg|gif|bmp|webp|tikz)$/i;
    const bibParser = new BibtexParser();

    // Collect all known file paths from structure tree
    for (const node of nodes) {
      if (node.isFolder()) continue;
      const relPath = FileTreeBuilder.toRelativeCompilerPath(node.path);
      if (!relPath) continue;
      allFilesSet.add(relPath);
      if (IMAGE_EXT_RE.test(relPath)) {
        imageFilesSet.add(relPath);
      }
      if (relPath.toLowerCase().endsWith('.bib')) {
        bibliographiesSet.add(relPath);
      }
    }

    for (const [filePath, lines] of docsToScan.entries()) {
      const docHash =
        docHashByPath.get(filePath) ||
        `${lines.length}:${lines[0]?.length ?? 0}:${lines[lines.length - 1] ?? ''}`;
      const cacheKey = `${filePath}:${docHash}`;
      let cached = this.docSymbolsCache.get(cacheKey);
      if (!cached) {
        cached = this.extractSingleDocSymbols(filePath, lines, bibParser);
        if (
          this.docSymbolsCache.size >=
          StructureService.MAX_DOC_SYMBOL_CACHE_ENTRIES
        ) {
          const oldestKey = this.docSymbolsCache.keys().next().value;
          if (oldestKey !== undefined) {
            this.docSymbolsCache.delete(oldestKey);
          }
        }
        this.docSymbolsCache.set(cacheKey, cached);
      }

      for (const lbl of cached.labels) {
        if (!labelsMap.has(lbl.key)) labelsMap.set(lbl.key, lbl);
      }
      for (const cit of cached.citations) {
        if (cit.type === 'bibitem') {
          if (!citationsMap.has(cit.key)) citationsMap.set(cit.key, cit);
        } else {
          citationsMap.set(cit.key, cit);
        }
      }
      for (const cmd of cached.customCommands) {
        if (cmd.signature === cmd.name && !cmd.expansion && commandsMap.has(cmd.name)) {
          continue;
        }
        commandsMap.set(cmd.name, cmd);
      }
      for (const env of cached.customEnvironments) {
        envsMap.set(env.name, env);
      }
      for (const pkg of cached.packages) {
        if (!packagesMap.has(pkg.name)) packagesMap.set(pkg.name, pkg);
      }
      for (const bib of cached.bibliographies) {
        bibliographiesSet.add(bib);
      }
      for (const inc of cached.includedFiles) {
        includedFilesSet.add(inc);
      }
      outline.push(...cached.outline);
    }

    const files = Array.from(allFilesSet);
    const imageFiles = Array.from(imageFilesSet);

    return {
      rootDocPath,
      labels: Array.from(labelsMap.values()),
      citations: Array.from(citationsMap.values()),
      customCommands: Array.from(commandsMap.values()),
      customEnvironments: Array.from(envsMap.values()),
      packages: Array.from(packagesMap.values()),
      bibliographies: Array.from(bibliographiesSet),
      includedFiles: Array.from(includedFilesSet),
      imageFiles,
      files,
      images: imageFiles,
      outline,
    };
  }

  private async loadProjectDocsContext(projectId: string): Promise<{
    nodes: ManuscriptNodeEntity[];
    allDocs: Awaited<ReturnType<DocstoreService['getAllDocs']>>;
    docContentsMap: Map<string, string[]>;
    docsToScan: Map<string, string[]>;
    docHashByPath: Map<string, string>;
    rootDocPath: string | null;
  }> {
    const [nodes, allDocs] = await Promise.all([
      this.repository.getAllNodes(projectId),
      this.docstoreService
        ? this.docstoreService.getAllDocs(projectId).catch(() => [])
        : Promise.resolve([]),
    ]);

    const docContentsMap = new Map<string, string[]>();
    const docHashByIdOrPath = new Map<string, string>();
    for (const d of allDocs) {
      const dId = d.id || d._id;
      const hashTag = d.hash ? `${d.hash}:${d.rev ?? 0}` : '';
      if (dId && Array.isArray(d.lines)) {
        docContentsMap.set(dId, d.lines);
        if (hashTag) docHashByIdOrPath.set(dId, hashTag);
      }
      if (d.path && Array.isArray(d.lines)) {
        const cleanPath = NodePathVo.toRelative(d.path);
        if (!docContentsMap.has(cleanPath)) {
          docContentsMap.set(cleanPath, d.lines);
        }
        if (hashTag && !docHashByIdOrPath.has(cleanPath)) {
          docHashByIdOrPath.set(cleanPath, hashTag);
        }
      }
    }

    let rootNode = nodes.find((n) => n.isRootDoc) ?? null;
    if (!rootNode) {
      rootNode = await this.autoDetectRootDoc(
        projectId,
        docContentsMap,
        nodes,
      ).catch(() => null);
    }
    const rootDocPath = rootNode
      ? FileTreeBuilder.toRelativeCompilerPath(rootNode.path)
      : null;

    const docsToScan = new Map<string, string[]>();
    const docHashByPath = new Map<string, string>();
    for (const node of nodes) {
      if (!node.isDoc()) continue;
      const relPath = FileTreeBuilder.toRelativeCompilerPath(node.path);
      const lines =
        (node.docId ? docContentsMap.get(node.docId) : undefined) ||
        docContentsMap.get(node.id) ||
        docContentsMap.get(relPath);
      if (lines) {
        docsToScan.set(relPath, lines);
        const h =
          (node.docId ? docHashByIdOrPath.get(node.docId) : undefined) ||
          docHashByIdOrPath.get(node.id) ||
          docHashByIdOrPath.get(relPath) ||
          node.hash ||
          '';
        if (h) docHashByPath.set(relPath, h);
      }
    }
    for (const d of allDocs) {
      const relPath = NodePathVo.toRelative(d.path || '');
      if (relPath && Array.isArray(d.lines) && !docsToScan.has(relPath)) {
        docsToScan.set(relPath, d.lines);
        const h = docHashByIdOrPath.get(relPath) || d.hash || '';
        if (h) docHashByPath.set(relPath, h);
      }
    }

    return {
      nodes,
      allDocs,
      docContentsMap,
      docsToScan,
      docHashByPath,
      rootDocPath,
    };
  }

  public async getProjectOutline(
    projectId: string,
    options?: { filePath?: string; docId?: string; content?: string },
  ): Promise<{
    rootDocPath: string | null;
    entries: LatexOutlineEntryDto[];
    tree: LatexOutlineEntryDto[];
  }> {
    if (options?.content !== undefined) {
      const targetFile = options.filePath || 'main.tex';
      const entries = LatexOutlineExtractor.extractFromContent(
        options.content,
        targetFile,
      );
      return {
        rootDocPath: targetFile,
        entries,
        tree: LatexOutlineExtractor.buildOutlineTree(entries),
      };
    }

    const { nodes, docContentsMap, docsToScan, rootDocPath } =
      await this.loadProjectDocsContext(projectId);

    if (options?.docId) {
      const lines = docContentsMap.get(options.docId);
      if (lines) {
        const matchingNode = nodes.find(
          (n) => n.docId === options.docId || n.id === options.docId,
        );
        const relPath = matchingNode
          ? FileTreeBuilder.toRelativeCompilerPath(matchingNode.path)
          : options.filePath || 'main.tex';
        const entries = LatexOutlineExtractor.extractFromContent(
          lines.join('\n'),
          relPath,
        );
        return {
          rootDocPath,
          entries,
          tree: LatexOutlineExtractor.buildOutlineTree(entries),
        };
      }
    }

    if (options?.filePath) {
      const cleanFilter = NodePathVo.toRelative(options.filePath);
      const matchedLines =
        docsToScan.get(cleanFilter) ??
        Array.from(docsToScan.entries()).find(
          ([k]) => k === cleanFilter || k.endsWith(`/${cleanFilter}`),
        )?.[1];
      const entries = LatexOutlineExtractor.extractFromContent(
        matchedLines ? matchedLines.join('\n') : '',
        cleanFilter,
      );
      return {
        rootDocPath,
        entries,
        tree: LatexOutlineExtractor.buildOutlineTree(entries),
      };
    }

    const allEntries: LatexOutlineEntryDto[] = [];
    for (const [relPath, lines] of docsToScan.entries()) {
      if (!relPath.toLowerCase().endsWith('.tex')) continue;
      allEntries.push(
        ...LatexOutlineExtractor.extractFromContent(lines.join('\n'), relPath),
      );
    }

    return {
      rootDocPath,
      entries: allEntries,
      tree: LatexOutlineExtractor.buildOutlineTree(allEntries),
    };
  }
}
