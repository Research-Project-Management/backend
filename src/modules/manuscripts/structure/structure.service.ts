/**
 * modules/manuscripts/structure/structure.service.ts
 * Main Injectable Service orchestrating Manuscript Project File Tree use cases.
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import { GetFileTreeUseCase } from './core/use-cases/get-file-tree.use-case';
import { CreateNodeUseCase } from './core/use-cases/create-node.use-case';
import { MoveNodeUseCase } from './core/use-cases/move-node.use-case';
import { RenameNodeUseCase } from './core/use-cases/rename-node.use-case';
import { DeleteNodeUseCase } from './core/use-cases/delete-node.use-case';
import { ResolveRootDocUseCase } from './core/use-cases/resolve-root-doc.use-case';
import { BuildCompilerFilesUseCase, CompilationPayload } from './core/use-cases/build-compiler-files.use-case';
import { IStructureRepository } from './core/ports/structure-repository.port';
import { ManuscriptNodeEntity } from './core/domain/manuscript-node.entity';
import { CreateNodeDto, MoveNodeDto, RenameNodeDto, TreeNodeDto } from './dto/node.dto';
import { RealtimeService } from '@/modules/realtime/realtime.service';

@Injectable()
export class StructureService {
  private readonly logger = new Logger(StructureService.name);

  constructor(
    private readonly structureRepository: IStructureRepository,
    private readonly getFileTreeUseCase: GetFileTreeUseCase,
    private readonly createNodeUseCase: CreateNodeUseCase,
    private readonly moveNodeUseCase: MoveNodeUseCase,
    private readonly renameNodeUseCase: RenameNodeUseCase,
    private readonly deleteNodeUseCase: DeleteNodeUseCase,
    private readonly resolveRootDocUseCase: ResolveRootDocUseCase,
    private readonly buildCompilerFilesUseCase: BuildCompilerFilesUseCase,
    @Optional() private readonly realtimeService?: RealtimeService,
  ) {}

  public async getFileTree(projectId: string): Promise<TreeNodeDto[]> {
    return await this.getFileTreeUseCase.execute(projectId);
  }

  public async getAllNodes(projectId: string): Promise<ManuscriptNodeEntity[]> {
    return await this.structureRepository.getAllNodes(projectId);
  }

  public async getNodeById(projectId: string, nodeId: string): Promise<ManuscriptNodeEntity | null> {
    return await this.structureRepository.findById(projectId, nodeId);
  }

  public async getNodeByPath(projectId: string, path: string): Promise<ManuscriptNodeEntity | null> {
    return await this.structureRepository.findByPath(projectId, path);
  }

  public async createNode(projectId: string, dto: CreateNodeDto): Promise<ManuscriptNodeEntity> {
    const node = await this.createNodeUseCase.execute(projectId, dto);
    this.realtimeService?.broadcastFileTreeChange(projectId, { action: 'create', node });
    return node;
  }

  public async mkdirp(projectId: string, dirPath: string): Promise<ManuscriptNodeEntity> {
    const node = await this.createNodeUseCase.mkdirp(projectId, dirPath);
    this.realtimeService?.broadcastFileTreeChange(projectId, { action: 'mkdirp', node });
    return node;
  }

  public async moveNode(projectId: string, nodeId: string, dto: MoveNodeDto): Promise<ManuscriptNodeEntity> {
    const node = await this.moveNodeUseCase.execute(projectId, nodeId, dto);
    this.realtimeService?.broadcastFileTreeChange(projectId, { action: 'move', node });
    return node;
  }

  public async renameNode(projectId: string, nodeId: string, dto: RenameNodeDto): Promise<ManuscriptNodeEntity> {
    const node = await this.renameNodeUseCase.execute(projectId, nodeId, dto.name);
    this.realtimeService?.broadcastFileTreeChange(projectId, { action: 'rename', node });
    return node;
  }

  public async deleteNode(projectId: string, nodeId: string): Promise<ManuscriptNodeEntity[]> {
    const deletedNodes = await this.deleteNodeUseCase.execute(projectId, nodeId);
    this.realtimeService?.broadcastFileTreeChange(projectId, { action: 'delete', node: { id: nodeId } });
    return deletedNodes;
  }

  public async getRootDoc(projectId: string): Promise<ManuscriptNodeEntity | null> {
    return await this.resolveRootDocUseCase.getRootDoc(projectId);
  }

  public async setRootDoc(projectId: string, nodeId: string): Promise<ManuscriptNodeEntity> {
    const node = await this.resolveRootDocUseCase.setRootDoc(projectId, nodeId);
    this.realtimeService?.broadcastFileTreeChange(projectId, { action: 'set-root', node });
    return node;
  }

  public async autoDetectRootDoc(
    projectId: string,
    docContents: Map<string, string[]>
  ): Promise<ManuscriptNodeEntity | null> {
    return await this.resolveRootDocUseCase.autoDetectAndSetRootDoc(projectId, docContents);
  }

  public async buildCompilerPayload(
    projectId: string,
    docContentsMap: Map<string, { lines: string[]; hash?: string | null }>
  ): Promise<CompilationPayload> {
    return await this.buildCompilerFilesUseCase.execute(projectId, docContentsMap);
  }

  public async reorderNode(projectId: string, nodeId: string, sortOrder: number): Promise<void> {
    await this.structureRepository.updateSortOrder(projectId, nodeId, sortOrder);
  }
}
