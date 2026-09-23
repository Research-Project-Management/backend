/**
 * modules/manuscripts/structure/structure.service.ts
 * Main Injectable Service orchestrating Manuscript Project File Tree use cases.
 */

import { Injectable, Logger } from '@nestjs/common';
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
    private readonly buildCompilerFilesUseCase: BuildCompilerFilesUseCase
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
    return await this.createNodeUseCase.execute(projectId, dto);
  }

  public async mkdirp(projectId: string, dirPath: string): Promise<ManuscriptNodeEntity> {
    return await this.createNodeUseCase.mkdirp(projectId, dirPath);
  }

  public async moveNode(projectId: string, nodeId: string, dto: MoveNodeDto): Promise<ManuscriptNodeEntity> {
    return await this.moveNodeUseCase.execute(projectId, nodeId, dto);
  }

  public async renameNode(projectId: string, nodeId: string, dto: RenameNodeDto): Promise<ManuscriptNodeEntity> {
    return await this.renameNodeUseCase.execute(projectId, nodeId, dto.name);
  }

  public async deleteNode(projectId: string, nodeId: string): Promise<ManuscriptNodeEntity[]> {
    return await this.deleteNodeUseCase.execute(projectId, nodeId);
  }

  public async getRootDoc(projectId: string): Promise<ManuscriptNodeEntity | null> {
    return await this.resolveRootDocUseCase.getRootDoc(projectId);
  }

  public async setRootDoc(projectId: string, nodeId: string): Promise<ManuscriptNodeEntity> {
    return await this.resolveRootDocUseCase.setRootDoc(projectId, nodeId);
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
