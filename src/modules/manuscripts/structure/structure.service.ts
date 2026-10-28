import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import {
  IStructureRepository,
  ManuscriptNodeEntity,
  NodePathVo,
  FileTreeBuilder,
  StructureError,
  DuplicateNodePathError,
  NodeNotFoundError,
  CannotDeleteRootFolderError,
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

export type { CompilationPayload };

@Injectable()
export class StructureService {
  private readonly logger = new Logger(StructureService.name);

  constructor(
    @Inject(IStructureRepository)
    private readonly repository: IStructureRepository,
    @Optional() private readonly realtimeService?: RealtimeFacade,
    @Optional() private readonly filestoreService?: FilestoreService,
    @Optional() private readonly docstoreService?: DocstoreService,
    @Optional() private readonly moduleRef?: ModuleRef,
    @Optional() private readonly domainEventBus?: ManuscriptDomainEventBus,
    @Optional()
    @Inject(LIVE_COLLABORATION_PORT)
    private readonly injectedLiveCollab?: LiveCollaborationPort,
  ) {}

  private get repo(): IStructureRepository {
    return this.repository;
  }

  private getLiveCollab(): LiveCollaborationPort | null {
    if (this.injectedLiveCollab) return this.injectedLiveCollab;
    if (!this.moduleRef) return null;
    try {
      return (
        this.moduleRef.get(LIVE_COLLABORATION_PORT, { strict: false }) ??
        this.moduleRef.get(LiveCollaborationPort, { strict: false }) ??
        null
      );
    } catch {
      return null;
    }
  }

  public async getFileTree(projectId: string): Promise<TreeNodeDto[]> {
    const nodes = await this.repo.getAllNodes(projectId);
    return FileTreeBuilder.buildTreeHierarchy(nodes);
  }

  public async getAllNodes(projectId: string): Promise<ManuscriptNodeEntity[]> {
    return await this.repo.getAllNodes(projectId);
  }

  public async getNodeById(
    projectId: string,
    nodeId: string,
  ): Promise<ManuscriptNodeEntity | null> {
    return await this.repo.findById(projectId, nodeId);
  }

  public async getNodeByPath(
    projectId: string,
    path: string,
  ): Promise<ManuscriptNodeEntity | null> {
    return await this.repo.findByPath(projectId, path);
  }

  public async createNode(
    projectId: string,
    dto: CreateNodeDto,
  ): Promise<ManuscriptNodeEntity> {
    NodePathVo.validateFilename(dto.name);

    const currentCount = await this.repo.countNodes(projectId);
    FileTreeBuilder.validateProjectFileLimit(currentCount);

    let parentNode: ManuscriptNodeEntity | null = null;
    let computedPath: string;

    if (dto.parentId) {
      parentNode = await this.repo.findById(projectId, dto.parentId);
      if (!parentNode) {
        throw new NodeNotFoundError(dto.parentId);
      }
      if (!parentNode.isFolder()) {
        throw new StructureError('Parent node must be a FOLDER');
      }
      computedPath = NodePathVo.join(parentNode.path, dto.name);
    } else if (dto.path) {
      computedPath = NodePathVo.normalize(dto.path);
      const dirname = NodePathVo.dirname(computedPath);
      if (dirname !== '/') {
        parentNode = await this.mkdirpInternal(projectId, dirname);
      }
    } else {
      computedPath = NodePathVo.join('/', dto.name);
    }

    const existing = await this.repo.findByPath(projectId, computedPath);
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

    if (dto.type === 'FILE' && dto.fileId && this.repo.findByFileId) {
      const preSyncedNode = await this.repo.findByFileId(projectId, dto.fileId);
      if (preSyncedNode) {
        await this.repo.moveSubtree(
          projectId,
          preSyncedNode.path,
          computedPath,
          parentNode ? parentNode.id : null,
        );
        const movedNode =
          (await this.repo.findById(projectId, preSyncedNode.id)) ??
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

    if (resolvedDocId && this.repo.docExistsInProject) {
      const exists = await this.repo.docExistsInProject(
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
    } else if (dto.type === 'DOC' && !resolvedDocId) {
      if (this.docstoreService) {
        const initialLines =
          dto.content && dto.content.length > 0
            ? dto.content.split(/\r?\n/)
            : [''];
        const createdDoc = await this.docstoreService.createDoc(projectId, {
          path: computedPath.replace(/^\/+/, ''),
          lines: initialLines,
        });
        resolvedDocId = createdDoc.id;
        resolvedSizeBytes = createdDoc.sizeBytes;
        resolvedHash = createdDoc.hash;
      } else if (this.repo.createBackingDoc) {
        const createdDoc = await this.repo.createBackingDoc(
          projectId,
          dto.name,
          computedPath,
          dto.content,
        );
        resolvedDocId = createdDoc.id;
        resolvedSizeBytes = createdDoc.sizeBytes;
        resolvedHash = createdDoc.hash;
      }
    }

    if (dto.fileId && this.repo.fileExistsInProject) {
      const exists = await this.repo.fileExistsInProject(projectId, dto.fileId);
      if (!exists) {
        throw new NotFoundException({
          statusCode: 404,
          code: 'RESOURCE_NOT_FOUND',
          message: 'File asset not found in project',
        });
      }
    }

    try {
      const node = await this.repo.createNode({
        projectId,
        parentId: parentNode ? parentNode.id : null,
        type: dto.type,
        name: dto.name,
        path: computedPath,
        docId: resolvedDocId,
        fileId: dto.fileId,
        isRootDoc: dto.isRootDoc ?? false,
        ...(resolvedSizeBytes !== undefined
          ? { sizeBytes: resolvedSizeBytes }
          : {}),
        ...(resolvedHash !== undefined ? { hash: resolvedHash } : {}),
      });

      if (dto.isRootDoc && dto.type === 'DOC') {
        try {
          await this.repo.setRootDoc(projectId, node.id);
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
            await this.docstoreService.patchDoc(projectId, resolvedDocId, {
              deleted: true,
              deletedAt: new Date().toISOString(),
            });
          }
        } catch (rollbackErr) {
          this.logger.warn(
            `Failed to soft-delete orphan backing doc ${resolvedDocId} after createNode error: ${String(rollbackErr)}`,
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
    const normalized = NodePathVo.normalize(dirPath);
    if (normalized === '/') {
      throw new StructureError('Cannot mkdirp root directory');
    }

    const segments = normalized.split('/').filter(Boolean);
    let currentPath = '';
    let parentNode: ManuscriptNodeEntity | null = null;

    for (const segment of segments) {
      NodePathVo.validateFilename(segment);
      currentPath = NodePathVo.join(currentPath, segment);
      let found = await this.repo.findByPath(projectId, currentPath);

      if (found && !found.isFolder()) {
        throw new DuplicateNodePathError(currentPath);
      }

      if (!found) {
        found = await this.repo.createNode({
          projectId,
          parentId: parentNode ? parentNode.id : null,
          type: 'FOLDER',
          name: segment,
          path: currentPath,
        });
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
    const targetNode = await this.repo.findById(projectId, nodeId);
    if (!targetNode) {
      throw new NodeNotFoundError(nodeId);
    }
    if (targetNode.path === '/') {
      throw new CannotDeleteRootFolderError();
    }

    let destPath: string;
    let newParentId: string | null = null;
    const targetParentId =
      dto.destParentId !== undefined ? dto.destParentId : dto.parentId;

    if (targetParentId) {
      const destParent = await this.repo.findById(projectId, targetParentId);
      if (!destParent) {
        throw new NodeNotFoundError(targetParentId);
      }
      if (!destParent.isFolder()) {
        throw new StructureError('Destination parent must be a FOLDER');
      }
      destPath = NodePathVo.join(destParent.path, targetNode.name);
      newParentId = destParent.id;
    } else if (dto.destPath) {
      destPath = NodePathVo.normalize(dto.destPath);
      NodePathVo.validateFilename(NodePathVo.basename(destPath));
      const parentPath = NodePathVo.dirname(destPath);
      if (parentPath !== '/') {
        const parentNode = await this.repo.findByPath(projectId, parentPath);
        if (parentNode && !parentNode.isFolder()) {
          throw new StructureError('Destination parent must be a FOLDER');
        }
        newParentId = parentNode ? parentNode.id : null;
      }
    } else {
      destPath = NodePathVo.join('/', targetNode.name);
      newParentId = null;
    }

    FileTreeBuilder.validateMoveTarget(targetNode, destPath);

    const existing = await this.repo.findByPath(projectId, destPath);
    if (existing && existing.id !== targetNode.id) {
      throw new DuplicateNodePathError(destPath);
    }

    const oldPath = targetNode.path;
    await this.repo.moveSubtree(projectId, oldPath, destPath, newParentId);

    const node = (await this.repo.findById(projectId, targetNode.id))!;

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
    const newName = dto.name;
    NodePathVo.validateFilename(newName);

    const existingNode = await this.repo.findById(projectId, nodeId);
    if (!existingNode) {
      throw new NodeNotFoundError(nodeId);
    }
    if (existingNode.path === '/') {
      throw new CannotDeleteRootFolderError();
    }

    let node: ManuscriptNodeEntity;
    if (existingNode.name === newName) {
      node = existingNode;
    } else {
      const parentPath = NodePathVo.dirname(existingNode.path);
      const newPath = NodePathVo.join(parentPath, newName);

      const conflict = await this.repo.findByPath(projectId, newPath);
      if (conflict && conflict.id !== existingNode.id) {
        throw new DuplicateNodePathError(newPath);
      }

      const oldPath = existingNode.path;
      if (existingNode.isFolder()) {
        await this.repo.moveSubtree(
          projectId,
          oldPath,
          newPath,
          existingNode.parentId,
        );
        node = (await this.repo.findById(projectId, existingNode.id))!;
      } else {
        node = await this.repo.renameNode(
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
    const node = await this.repo.findById(projectId, nodeId);
    if (!node) {
      throw new NodeNotFoundError(nodeId);
    }
    if (node.path === '/') {
      throw new CannotDeleteRootFolderError();
    }

    const deletedNodes = await this.repo.deleteSubtree(projectId, node.path);

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

    if (this.domainEventBus) {
      await this.domainEventBus.publish({
        type: 'manuscript.nodes.deleted',
        projectId,
        deletedDocIds: docIds,
        deletedFileIds: fileIds,
        hadRootDoc,
        occurredAt: Date.now(),
      });
    } else {
      const liveCollab = this.getLiveCollab();
      if (liveCollab) {
        for (const docId of docIds) {
          try {
            await liveCollab.evictDoc(projectId, docId);
          } catch (evictErr) {
            this.logger.warn(
              `Failed to evict live doc ${projectId}:${docId} during node deletion: ${String(evictErr)}`,
            );
          }
        }
      }
    }

    if (hadRootDoc) {
      await this.repo.unsetRootDoc(projectId);
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
    return await this.repo.getRootDoc(projectId);
  }

  public async setRootDoc(
    projectId: string,
    nodeId: string,
  ): Promise<ManuscriptNodeEntity> {
    const found = await this.repo.findById(projectId, nodeId);
    if (!found) {
      throw new NodeNotFoundError(nodeId);
    }
    if (!found.isDoc() && !found.name.toLowerCase().endsWith('.tex')) {
      throw new StructureError(
        `Cannot set node of type ${found.type} as root document. Must be a LaTeX document (.tex).`,
      );
    }

    await this.repo.setRootDoc(projectId, found.id);
    const node = (await this.repo.findById(projectId, found.id))!;

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
      : await this.repo.getRootDoc(projectId);
    if (existing) {
      return existing;
    }

    const allNodes = existingNodes ?? (await this.repo.getAllNodes(projectId));
    const detected = FileTreeBuilder.detectRootDoc(allNodes, docContents);

    if (detected) {
      await this.repo.setRootDoc(projectId, detected.id);
      this.logger.log(
        `Auto-detected root document '${detected.path}' for project ${projectId}`,
      );

      return (await this.repo.findById(projectId, detected.id)) ?? detected;
    }

    return null;
  }

  public async buildCompilerPayload(
    projectId: string,
    docContentsMap: Map<string, { lines: string[]; hash?: string | null }>,
  ): Promise<CompilationPayload> {
    const nodes = await this.repo.getAllNodes(projectId);

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

    const files: WorkspaceFile[] = [];

    for (const node of nodes) {
      if (node.isFolder()) continue;

      const relativePath = FileTreeBuilder.toRelativeCompilerPath(node.path);

      if (node.isDoc()) {
        const docData =
          docContentsMap.get(node.id) ||
          (node.docId ? docContentsMap.get(node.docId) : undefined);
        const content = docData ? docData.lines.join('\n') : '';
        const hash = docData?.hash || node.hash || undefined;

        files.push({
          path: relativePath,
          content,
          hash,
        });
      } else if (node.isFile()) {
        let binaryContent: Buffer | string = '';
        if (node.fileId && this.filestoreService) {
          try {
            const { stream } = await this.filestoreService.openReadStream(
              projectId,
              node.fileId,
            );
            const chunks: Buffer[] = [];
            for await (const chunk of stream) {
              chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            }
            binaryContent = Buffer.concat(chunks);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            this.logger.warn(
              `Failed to read binary file ${node.fileId} (${relativePath}) from filestore: ${msg}`,
            );
          }
        }

        files.push({
          path: relativePath,
          content: binaryContent,
          hash: node.hash || undefined,
        });
      }
    }

    return {
      rootDocPath: FileTreeBuilder.toRelativeCompilerPath(rootNode.path),
      files,
    };
  }

  public async reorderNode(
    projectId: string,
    nodeId: string,
    sortOrder: number,
  ): Promise<void> {
    await this.repo.updateSortOrder(projectId, nodeId, sortOrder);
  }

  public async updateNodeFileId(
    projectId: string,
    nodeId: string,
    fileId: string,
    sizeBytes?: number,
    hash?: string | null,
  ): Promise<ManuscriptNodeEntity> {
    if (!this.repo.updateNodeFileId) {
      throw new StructureError(
        'updateNodeFileId is not supported by this repository',
      );
    }
    const node = await this.repo.updateNodeFileId(
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
