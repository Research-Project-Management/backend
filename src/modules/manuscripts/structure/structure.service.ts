/**
 * modules/manuscripts/structure/structure.service.ts
 * Deep module facade orchestrating Manuscript Project File Tree & Hierarchy operations.
 * Executes directly via StructureRepository / IStructureRepository and pure domain FileTreeBuilder.
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import { GetFileTreeUseCase } from './core/use-cases/get-file-tree.use-case';
import { CreateNodeUseCase } from './core/use-cases/create-node.use-case';
import { MoveNodeUseCase } from './core/use-cases/move-node.use-case';
import { RenameNodeUseCase } from './core/use-cases/rename-node.use-case';
import { DeleteNodeUseCase } from './core/use-cases/delete-node.use-case';
import { ResolveRootDocUseCase } from './core/use-cases/resolve-root-doc.use-case';
import {
  BuildCompilerFilesUseCase,
  CompilationPayload,
} from './core/use-cases/build-compiler-files.use-case';
import { IStructureRepository } from './core/ports/structure-repository.port';
import { ITreePublisher } from './core/ports/tree-publisher.port';
import {
  ManuscriptNodeEntity,
  NodePathVo,
  FileTreeBuilder,
  DuplicateNodePathError,
  NodeNotFoundError,
  CannotDeleteRootFolderError,
  RootDocNotFoundError,
} from './domain';
import { StructureRepository } from './structure.repository';
import {
  CreateNodeDto,
  MoveNodeDto,
  RenameNodeDto,
  TreeNodeDto,
} from './dto/node.dto';
import { WorkspaceFile } from '@/modules/manuscripts/clsi/domain';
import { FilestoreService } from '@/modules/manuscripts/filestore/filestore.service';
import { RealtimeService } from '@/modules/realtime/realtime.service';

@Injectable()
export class StructureService {
  private readonly logger = new Logger(StructureService.name);

  constructor(
    @Optional() private readonly structureRepository?: IStructureRepository,
    @Optional() private readonly getFileTreeUseCase?: GetFileTreeUseCase,
    @Optional() private readonly createNodeUseCase?: CreateNodeUseCase,
    @Optional() private readonly moveNodeUseCase?: MoveNodeUseCase,
    @Optional() private readonly renameNodeUseCase?: RenameNodeUseCase,
    @Optional() private readonly deleteNodeUseCase?: DeleteNodeUseCase,
    @Optional() private readonly resolveRootDocUseCase?: ResolveRootDocUseCase,
    @Optional()
    private readonly buildCompilerFilesUseCase?: BuildCompilerFilesUseCase,
    @Optional() private readonly realtimeService?: RealtimeService,
    @Optional() private readonly directRepository?: StructureRepository,
    @Optional() private readonly treePublisher?: ITreePublisher,
    @Optional() private readonly filestoreService?: FilestoreService,
  ) {}

  private get repo(): IStructureRepository | undefined {
    return this.structureRepository ?? this.directRepository;
  }

  public async getFileTree(projectId: string): Promise<TreeNodeDto[]> {
    if (this.repo) {
      const nodes = await this.repo.getAllNodes(projectId);
      return FileTreeBuilder.buildTreeHierarchy(nodes);
    }
    if (this.getFileTreeUseCase) {
      return await this.getFileTreeUseCase.execute(projectId);
    }
    throw new Error('StructureService is not configured with a repository');
  }

  public async getAllNodes(projectId: string): Promise<ManuscriptNodeEntity[]> {
    return await this.repo!.getAllNodes(projectId);
  }

  public async getNodeById(
    projectId: string,
    nodeId: string,
  ): Promise<ManuscriptNodeEntity | null> {
    return await this.repo!.findById(projectId, nodeId);
  }

  public async getNodeByPath(
    projectId: string,
    path: string,
  ): Promise<ManuscriptNodeEntity | null> {
    return await this.repo!.findByPath(projectId, path);
  }

  public async createNode(
    projectId: string,
    dto: CreateNodeDto,
  ): Promise<ManuscriptNodeEntity> {
    let node: ManuscriptNodeEntity;

    if (this.repo) {
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
          throw new Error('Parent node must be a FOLDER');
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
        throw new DuplicateNodePathError(computedPath);
      }

      node = await this.repo.createNode({
        projectId,
        parentId: parentNode ? parentNode.id : null,
        type: dto.type,
        name: dto.name,
        path: computedPath,
        docId: dto.docId,
        fileId: dto.fileId,
        isRootDoc: dto.isRootDoc ?? false,
      });

      if (dto.isRootDoc && dto.type === 'DOC') {
        await this.repo.setRootDoc(projectId, node.id);
      }

      await this.treePublisher?.publishTreeMutation({
        projectId,
        action: 'create',
        nodeId: node.id,
        path: node.path,
        entityType: node.type,
      });
    } else if (this.createNodeUseCase) {
      node = await this.createNodeUseCase.execute(projectId, dto);
    } else {
      throw new Error('StructureService is not configured with a repository');
    }

    this.realtimeService?.broadcastFileTreeChange(projectId, {
      action: 'create',
      node,
    });
    return node;
  }

  private async mkdirpInternal(
    projectId: string,
    dirPath: string,
  ): Promise<ManuscriptNodeEntity> {
    const normalized = NodePathVo.normalize(dirPath);
    if (normalized === '/') {
      throw new Error('Cannot mkdirp root directory');
    }

    const segments = normalized.split('/').filter(Boolean);
    let currentPath = '';
    let parentNode: ManuscriptNodeEntity | null = null;

    for (const segment of segments) {
      NodePathVo.validateFilename(segment);
      currentPath = NodePathVo.join(currentPath, segment);
      let found = await this.repo!.findByPath(projectId, currentPath);

      if (found && !found.isFolder()) {
        throw new DuplicateNodePathError(currentPath);
      }

      if (!found) {
        found = await this.repo!.createNode({
          projectId,
          parentId: parentNode ? parentNode.id : null,
          type: 'FOLDER',
          name: segment,
          path: currentPath,
        });

        await this.treePublisher?.publishTreeMutation({
          projectId,
          action: 'create',
          nodeId: found.id,
          path: found.path,
          entityType: 'FOLDER',
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
    const node = this.repo
      ? await this.mkdirpInternal(projectId, dirPath)
      : await this.createNodeUseCase!.mkdirp(projectId, dirPath);
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
    let node: ManuscriptNodeEntity;

    if (this.repo) {
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
          throw new Error('Destination parent must be a FOLDER');
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
            throw new Error('Destination parent must be a FOLDER');
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

      node = (await this.repo.findById(projectId, targetNode.id))!;

      await this.treePublisher?.publishTreeMutation({
        projectId,
        action: 'move',
        nodeId: node.id,
        path: node.path,
        oldPath,
        entityType: node.type,
      });
    } else if (this.moveNodeUseCase) {
      node = await this.moveNodeUseCase.execute(projectId, nodeId, dto);
    } else {
      throw new Error('StructureService is not configured with a repository');
    }

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
    let node: ManuscriptNodeEntity;

    if (this.repo) {
      const newName = dto.name;
      NodePathVo.validateFilename(newName);

      const existingNode = await this.repo.findById(projectId, nodeId);
      if (!existingNode) {
        throw new NodeNotFoundError(nodeId);
      }
      if (existingNode.path === '/') {
        throw new CannotDeleteRootFolderError();
      }

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

        await this.treePublisher?.publishTreeMutation({
          projectId,
          action: 'rename',
          nodeId: node.id,
          path: node.path,
          oldPath,
          entityType: node.type,
          data: { oldName: existingNode.name, newName },
        });
      }
    } else if (this.renameNodeUseCase) {
      node = await this.renameNodeUseCase.execute(projectId, nodeId, dto.name);
    } else {
      throw new Error('StructureService is not configured with a repository');
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
    let deletedNodes: ManuscriptNodeEntity[];

    if (this.repo) {
      const node = await this.repo.findById(projectId, nodeId);
      if (!node) {
        throw new NodeNotFoundError(nodeId);
      }
      if (node.path === '/') {
        throw new CannotDeleteRootFolderError();
      }

      deletedNodes = await this.repo.deleteSubtree(projectId, node.path);

      const hadRootDoc = deletedNodes.some((n) => n.isRootDoc);
      if (hadRootDoc) {
        await this.repo.unsetRootDoc(projectId);
      }

      await this.treePublisher?.publishTreeMutation({
        projectId,
        action: 'delete',
        nodeId: node.id,
        path: node.path,
        entityType: node.type,
        data: { deletedCount: deletedNodes.length, hadRootDoc },
      });
    } else if (this.deleteNodeUseCase) {
      deletedNodes = await this.deleteNodeUseCase.execute(projectId, nodeId);
    } else {
      throw new Error('StructureService is not configured with a repository');
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
    if (this.repo) {
      return await this.repo.getRootDoc(projectId);
    }
    return await this.resolveRootDocUseCase!.getRootDoc(projectId);
  }

  public async setRootDoc(
    projectId: string,
    nodeId: string,
  ): Promise<ManuscriptNodeEntity> {
    let node: ManuscriptNodeEntity;

    if (this.repo) {
      const found = await this.repo.findById(projectId, nodeId);
      if (!found) {
        throw new NodeNotFoundError(nodeId);
      }
      if (!found.isDoc() && !found.name.toLowerCase().endsWith('.tex')) {
        throw new Error(
          `Cannot set node of type ${found.type} as root document. Must be a LaTeX document (.tex).`,
        );
      }

      await this.repo.setRootDoc(projectId, found.id);
      node = (await this.repo.findById(projectId, found.id))!;

      await this.treePublisher?.publishTreeMutation({
        projectId,
        action: 'root_doc_changed',
        nodeId: node.id,
        path: node.path,
        entityType: node.type,
      });
    } else if (this.resolveRootDocUseCase) {
      node = await this.resolveRootDocUseCase.setRootDoc(projectId, nodeId);
    } else {
      throw new Error('StructureService is not configured with a repository');
    }

    this.realtimeService?.broadcastFileTreeChange(projectId, {
      action: 'set-root',
      node,
    });
    return node;
  }

  public async autoDetectRootDoc(
    projectId: string,
    docContents: Map<string, string[]>,
  ): Promise<ManuscriptNodeEntity | null> {
    if (this.repo) {
      const existing = await this.repo.getRootDoc(projectId);
      if (existing) {
        return existing;
      }

      const allNodes = await this.repo.getAllNodes(projectId);
      const detected = FileTreeBuilder.detectRootDoc(allNodes, docContents);

      if (detected) {
        await this.repo.setRootDoc(projectId, detected.id);
        this.logger.log(
          `Auto-detected root document '${detected.path}' for project ${projectId}`,
        );

        await this.treePublisher?.publishTreeMutation({
          projectId,
          action: 'root_doc_changed',
          nodeId: detected.id,
          path: detected.path,
          entityType: detected.type,
        });

        return (await this.repo.findById(projectId, detected.id))!;
      }

      return null;
    }

    return await this.resolveRootDocUseCase!.autoDetectAndSetRootDoc(
      projectId,
      docContents,
    );
  }

  public async buildCompilerPayload(
    projectId: string,
    docContentsMap: Map<string, { lines: string[]; hash?: string | null }>,
  ): Promise<CompilationPayload> {
    if (this.repo) {
      const nodes = await this.repo.getAllNodes(projectId);

      let rootNode = await this.getRootDoc(projectId);
      if (!rootNode) {
        const linesMap = new Map<string, string[]>();
        for (const [id, val] of docContentsMap.entries()) {
          linesMap.set(id, val.lines);
        }
        rootNode = await this.autoDetectRootDoc(projectId, linesMap);
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

    return await this.buildCompilerFilesUseCase!.execute(
      projectId,
      docContentsMap,
    );
  }

  public async reorderNode(
    projectId: string,
    nodeId: string,
    sortOrder: number,
  ): Promise<void> {
    await this.repo!.updateSortOrder(projectId, nodeId, sortOrder);
  }

  public async updateNodeFileId(
    projectId: string,
    nodeId: string,
    fileId: string,
    sizeBytes?: number,
    hash?: string | null,
  ): Promise<ManuscriptNodeEntity> {
    const node = await this.repo!.updateNodeFileId(
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
