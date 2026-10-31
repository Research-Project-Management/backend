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
} from '@/modules/manuscripts/core';
import { DocstoreService } from '@/modules/manuscripts/docstore/docstore.service';
import { FilestoreService } from '@/modules/manuscripts/filestore/filestore.service';
import { RealtimeFacade } from '@/modules/realtime/realtime.facade';
import { StructureRepository } from './structure.repository';

export type { CompilationPayload };

@Injectable()
export class StructureService {
  private readonly logger = new Logger(StructureService.name);
  private readonly domainEventBus: ManuscriptDomainEventBus;

  constructor(
    @Inject(IStructureRepository)
    private readonly repository: IStructureRepository,
    @Optional() private readonly realtimeService?: RealtimeFacade,
    @Optional() private readonly filestoreService?: FilestoreService,
    @Optional() private readonly docstoreService?: DocstoreService,
    @Optional()
    @Inject(ManuscriptDomainEventBus)
    _legacyOrEventBus?: ManuscriptDomainEventBus | unknown,
    @Optional() domainEventBus?: ManuscriptDomainEventBus,
    @Optional()
    @Inject(LIVE_COLLABORATION_PORT)
    private readonly injectedLiveCollab?: LiveCollaborationPort,
  ) {
    const resolvedBus =
      domainEventBus ??
      (_legacyOrEventBus &&
      typeof (_legacyOrEventBus as ManuscriptDomainEventBus).publish ===
        'function'
        ? (_legacyOrEventBus as ManuscriptDomainEventBus)
        : undefined);
    this.domainEventBus =
      resolvedBus ?? new ManuscriptDomainEventBus(this.injectedLiveCollab);
  }

  public async getFileTree(projectId: string): Promise<TreeNodeDto[]> {
    const nodes = await this.repository.getAllNodes(projectId);
    return FileTreeBuilder.buildTreeHierarchy(nodes);
  }

  public async getAllNodes(projectId: string): Promise<ManuscriptNodeEntity[]> {
    return await this.repository.getAllNodes(projectId);
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

    let currentPath = '';
    let parentNode: ManuscriptNodeEntity | null = null;

    for (const segment of parsed.segments) {
      currentPath = NodePathVo.join(currentPath, segment);
      let found = await this.repository.findByPath(projectId, currentPath);

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
}
