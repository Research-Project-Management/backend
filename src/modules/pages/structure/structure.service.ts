import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { StructureRepository } from './structure.repository';
import { PageNodeEntity } from './domain/node.entity';
import { FileTreeBuilder } from './domain/tree-builder';
import { StructureError, NodeNotFoundError } from './domain/structure.errors';
import { LatexOutlineEntryDto } from './domain/latex-outline.extractor';
import {
  CreateNodeDto,
  MoveNodeDto,
  RenameNodeDto,
  TreeNodeDto,
} from './dto/node.dto';
import { CompilationPayload } from '@/modules/pages/core/types/workspace-file';
import {
  LIVE_COLLABORATION_PORT,
  LiveCollaborationPort,
} from '@/modules/pages/core/ports/live-collaboration.port';
import { PageDomainEventBus } from '@/modules/pages/core/events/event-bus.service';
import { DocstoreService } from '@/modules/pages/docstore/docstore.service';
import { FilestoreService } from '@/modules/pages/filestore/filestore.service';
import { RealtimeFacade } from '@/modules/realtime/realtime.facade';
import {
  type NodeMutationContext,
  createNodeHelper,
  deleteNodeHelper,
  mkdirpInternalHelper,
  moveNodeHelper,
  renameNodeHelper,
} from './services/node-mutation';
import {
  type CachedDocSymbols,
  type ProjectSymbolCitationDto,
  type ProjectSymbolCommandDto,
  type ProjectSymbolEnvironmentDto,
  type ProjectSymbolLabelDto,
  type ProjectSymbolOutlineDto,
  type ProjectSymbolPackageDto,
  type ProjectSymbolsContext,
  type ProjectSymbolsResponseDto,
  buildCompilerPayloadHelper,
  getProjectOutlineHelper,
  getProjectSymbolsHelper,
} from './services/symbols-extractor';

export type {
  CompilationPayload,
  ProjectSymbolLabelDto,
  ProjectSymbolCitationDto,
  ProjectSymbolCommandDto,
  ProjectSymbolEnvironmentDto,
  ProjectSymbolPackageDto,
  ProjectSymbolOutlineDto,
  ProjectSymbolsResponseDto,
};

@Injectable()
export class StructureService {
  private static readonly MAX_DOC_SYMBOL_CACHE_ENTRIES = 2000;
  private readonly logger = new Logger(StructureService.name);
  private readonly domainEventBus: PageDomainEventBus;
  private readonly docSymbolsCache = new Map<string, CachedDocSymbols>();

  constructor(
    private readonly repository: StructureRepository,
    @Optional() private readonly realtimeService?: RealtimeFacade,
    @Optional() private readonly filestoreService?: FilestoreService,
    @Optional() private readonly docstoreService?: DocstoreService,
    @Optional()
    @Inject(PageDomainEventBus)
    domainEventBus?: PageDomainEventBus,
    @Optional()
    @Inject(LIVE_COLLABORATION_PORT)
    private readonly injectedLiveCollab?: LiveCollaborationPort,
  ) {
    if (!domainEventBus && process.env.NODE_ENV !== 'test') {
      this.logger.warn(
        'StructureService initialized without injected PageDomainEventBus; falling back to local bus.',
      );
    }
    this.domainEventBus =
      domainEventBus ?? new PageDomainEventBus(this.injectedLiveCollab);
  }

  private getMutationContext(): NodeMutationContext {
    return {
      repository: this.repository,
      logger: this.logger,
      domainEventBus: this.domainEventBus,
      realtimeService: this.realtimeService,
      filestoreService: this.filestoreService,
      docstoreService: this.docstoreService,
    };
  }

  private getSymbolsContext(): ProjectSymbolsContext {
    return {
      repository: this.repository,
      logger: this.logger,
      docstoreService: this.docstoreService,
      filestoreService: this.filestoreService,
      autoDetectRootDoc: (projectId, docContents, existingNodes, pageId) =>
        this.autoDetectRootDoc(projectId, docContents, existingNodes, pageId),
    };
  }

  public async getFileTree(
    projectId: string,
    pageId?: string,
  ): Promise<TreeNodeDto[]> {
    const nodes = await this.repository.getAllNodes(projectId, pageId);
    return FileTreeBuilder.buildTreeHierarchy(nodes);
  }

  public async getAllNodes(
    projectId: string,
    parentId?: string,
    pageId?: string,
  ): Promise<PageNodeEntity[]> {
    const nodes = await this.repository.getAllNodes(projectId, pageId);
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
  ): Promise<PageNodeEntity | null> {
    return await this.repository.findById(projectId, nodeId);
  }

  public async getNodeByPath(
    projectId: string,
    path: string,
    pageId?: string,
  ): Promise<PageNodeEntity | null> {
    return await this.repository.findByPath(projectId, path, pageId);
  }

  public async createNode(
    projectId: string,
    dto: CreateNodeDto,
    pageId?: string,
  ): Promise<PageNodeEntity> {
    return await createNodeHelper(
      this.getMutationContext(),
      projectId,
      dto,
      pageId,
    );
  }

  public async mkdirp(
    projectId: string,
    dirPath: string,
    pageId?: string,
  ): Promise<PageNodeEntity> {
    const node = await mkdirpInternalHelper(
      this.repository,
      projectId,
      dirPath,
      pageId,
    );
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
  ): Promise<PageNodeEntity> {
    return await moveNodeHelper(
      this.getMutationContext(),
      projectId,
      nodeId,
      dto,
    );
  }

  public async renameNode(
    projectId: string,
    nodeId: string,
    dto: RenameNodeDto,
  ): Promise<PageNodeEntity> {
    return await renameNodeHelper(
      this.getMutationContext(),
      projectId,
      nodeId,
      dto,
    );
  }

  public async deleteNode(
    projectId: string,
    nodeId: string,
  ): Promise<PageNodeEntity[]> {
    return await deleteNodeHelper(
      this.getMutationContext(),
      projectId,
      nodeId,
      (pId, docContents, existingNodes, pgId) =>
        this.autoDetectRootDoc(pId, docContents, existingNodes, pgId),
    );
  }

  public async getRootDoc(
    projectId: string,
    pageId?: string,
  ): Promise<PageNodeEntity | null> {
    return await this.repository.getRootDoc(projectId, pageId);
  }

  public async setRootDoc(
    projectId: string,
    nodeId: string,
  ): Promise<PageNodeEntity> {
    const found = await this.repository.findById(projectId, nodeId);
    if (!found) {
      throw new NodeNotFoundError(nodeId);
    }
    found.assertCanBeRootDoc();

    await this.repository.setRootDoc(projectId, found.id);
    found.markAsRootDoc(true);
    const node = (await this.repository.findById(projectId, found.id)) ?? found;

    this.realtimeService?.broadcastFileTreeChange(projectId, {
      action: 'set-root',
      node,
    });
    return node;
  }

  public async autoDetectRootDoc(
    projectId: string,
    docContents: Map<string, string[]>,
    existingNodes?: PageNodeEntity[],
    pageId?: string | null,
  ): Promise<PageNodeEntity | null> {
    const existing = existingNodes
      ? (existingNodes.find((n) => n.isRootDoc) ?? null)
      : await this.repository.getRootDoc(projectId, pageId);
    if (existing) {
      return existing;
    }

    const allNodes =
      existingNodes ?? (await this.repository.getAllNodes(projectId, pageId));
    const detected = FileTreeBuilder.detectRootDoc(allNodes, docContents);

    if (detected) {
      await this.repository.setRootDoc(projectId, detected.id);
      this.logger.log(
        `Auto-detected root document '${detected.path}' for project ${projectId}`,
      );

      return (
        (await this.repository.findById(projectId, detected.id)) ?? detected
      );
    }

    return null;
  }

  public async buildCompilerPayload(
    projectId: string,
    docContentsMap: Map<string, { lines: string[]; hash?: string | null }>,
    pageId?: string,
  ): Promise<CompilationPayload> {
    return await buildCompilerPayloadHelper(
      this.getSymbolsContext(),
      projectId,
      docContentsMap,
      pageId,
    );
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
  ): Promise<PageNodeEntity> {
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

  public async getProjectSymbols(
    projectId: string,
    pageId?: string,
    preloadedNodes?: PageNodeEntity[],
  ): Promise<ProjectSymbolsResponseDto> {
    return await getProjectSymbolsHelper(
      this.getSymbolsContext(),
      this.docSymbolsCache,
      StructureService.MAX_DOC_SYMBOL_CACHE_ENTRIES,
      projectId,
      pageId,
      preloadedNodes,
    );
  }

  public async getProjectOutline(
    projectId: string,
    options?: { filePath?: string; docId?: string; content?: string },
    pageId?: string,
  ): Promise<{
    rootDocPath: string | null;
    entries: LatexOutlineEntryDto[];
    tree: LatexOutlineEntryDto[];
  }> {
    return await getProjectOutlineHelper(
      this.getSymbolsContext(),
      projectId,
      options,
      pageId,
    );
  }
}
