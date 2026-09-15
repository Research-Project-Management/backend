import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Optional,
  Logger,
} from '@nestjs/common';
import { NodeRepository, NodeTreeRecord } from './node.repository';
import { MoveNodeDto, CreateChildNodeDto, NodeTreeItem } from './dto/node.dto';
import { RedisCacheService } from '@/core/cache/redis.service';
import { DOCUMENT_REDIS_KEYS } from '../core/constants/redis-keys.constant';
import { PageStatus, Prisma } from '@prisma/client';
import {
  sanitizeDocumentTitle,
  slugifyTitle,
} from '../core/utils/document.utils';

@Injectable()
export class NodeService {
  private readonly logger = new Logger(NodeService.name);

  constructor(
    private readonly nodeRepo: NodeRepository,
    @Optional() private readonly cache?: RedisCacheService,
  ) {}

  private async invalidateTreeCache(projectId: string): Promise<void> {
    if (!this.cache) return;
    await this.cache.del(DOCUMENT_REDIS_KEYS.projectTree(projectId));
  }

  /**
   * Builds a nested hierarchical tree structure from a flat array of nodes.
   */
  private buildNestedTree(nodes: NodeTreeRecord[]): NodeTreeItem[] {
    const nodeMap = new Map<string, NodeTreeItem>();
    const rootNodes: NodeTreeItem[] = [];

    // Initialize all items with empty children
    for (const record of nodes) {
      nodeMap.set(record.id, {
        id: record.id,
        title: record.title,
        slug: record.slug,
        icon: record.icon,
        rank: record.rank,
        status: record.status,
        isLocked: record.isLocked,
        parentPageId: record.parentPageId,
        mainFileId: record.mainFileId,
        projectId: record.projectId,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        children: [],
      });
    }

    // Assemble parent-child relationships
    for (const record of nodes) {
      const item = nodeMap.get(record.id)!;
      if (record.parentPageId && nodeMap.has(record.parentPageId)) {
        const parent = nodeMap.get(record.parentPageId)!;
        parent.children = parent.children || [];
        parent.children.push(item);
      } else {
        rootNodes.push(item);
      }
    }

    return rootNodes;
  }

  /**
   * Returns project nodes both as an ordered flat list and a fully nested tree.
   */
  async getProjectTree(projectId: string) {
    const canonicalId = await this.nodeRepo.resolveProjectId(projectId);
    if (!canonicalId) {
      return { nodes: [], tree: [] };
    }

    const cacheKey = DOCUMENT_REDIS_KEYS.projectTree(canonicalId);

    if (this.cache) {
      const cached = await this.cache.get<{
        nodes: NodeTreeRecord[];
        tree: NodeTreeItem[];
      }>(cacheKey);
      if (cached) {
        return cached;
      }
    }

    const nodes = await this.nodeRepo.findProjectNodes(canonicalId);
    const tree = this.buildNestedTree(nodes);
    const result = { nodes, tree };

    if (this.cache) {
      await this.cache.set(cacheKey, result, 3600);
    }

    return result;
  }

  /**
   * Retrieves the breadcrumb ancestor chain from a node up to the root.
   */
  async getAncestors(nodeId: string) {
    const ancestors = await this.nodeRepo.findNodeAncestors(nodeId);
    return { ancestors };
  }

  /**
   * Cycle-detection: prevents assigning a node as a child/descendant of itself.
   */
  async assertNoCircularReference(
    nodeId: string,
    targetParentId: string,
  ): Promise<void> {
    if (nodeId === targetParentId) {
      throw new BadRequestException('A node cannot be its own parent');
    }

    const ancestors = await this.nodeRepo.findNodeAncestors(targetParentId);
    const ancestorIds = new Set(ancestors.map((a) => a.id));

    if (ancestorIds.has(nodeId)) {
      throw new BadRequestException(
        'Circular parent node reference detected: target parent is already a descendant of this node',
      );
    }
  }

  /**
   * Move or reorder a node within the document tree.
   */
  async moveNode(nodeId: string, dto: MoveNodeDto, projectId?: string) {
    const node = await this.nodeRepo.findNodeById(nodeId);
    if (!node) {
      throw new NotFoundException(`Node ${nodeId} not found`);
    }

    if (projectId && node.projectId !== projectId) {
      throw new NotFoundException('Node does not belong to this project');
    }

    const targetParentId = dto.targetParentId ?? null;

    if (targetParentId) {
      await this.assertNoCircularReference(nodeId, targetParentId);

      const targetParent = await this.nodeRepo.findNodeById(targetParentId);
      if (!targetParent) {
        throw new NotFoundException(
          `Target parent node ${targetParentId} not found`,
        );
      }
      if (targetParent.projectId !== node.projectId) {
        throw new BadRequestException(
          'Target parent node belongs to a different project',
        );
      }
    }

    const newRank = dto.rank !== undefined ? dto.rank : node.rank;
    const updated = await this.nodeRepo.updateParentAndRank(
      nodeId,
      targetParentId,
      newRank,
    );

    await this.invalidateTreeCache(node.projectId);

    return { node: updated };
  }

  /**
   * Designates a file node as the primary compilation entry-point (e.g. main.tex).
   */
  async setMainFile(nodeId: string, mainFileId: string, projectId?: string) {
    const node = await this.nodeRepo.findNodeById(nodeId);
    if (!node) {
      throw new NotFoundException(`Node ${nodeId} not found`);
    }

    if (projectId && node.projectId !== projectId) {
      throw new NotFoundException('Node does not belong to this project');
    }

    const mainFile = await this.nodeRepo.findNodeById(mainFileId);
    if (!mainFile) {
      throw new NotFoundException(`File node ${mainFileId} not found`);
    }

    if (mainFile.projectId !== node.projectId) {
      throw new BadRequestException(
        'Main file node belongs to a different project',
      );
    }

    const updated = await this.nodeRepo.setMainFile(nodeId, mainFileId);
    await this.invalidateTreeCache(node.projectId);

    return { node: updated };
  }

  /**
   * Creates a child node (file, section, sub-document) within a parent node.
   */
  async createChildNode(
    parentNodeId: string,
    userId: string,
    dto: CreateChildNodeDto,
    projectId?: string,
  ) {
    const parent = await this.nodeRepo.findNodeById(parentNodeId);
    if (!parent) {
      throw new NotFoundException(`Parent node ${parentNodeId} not found`);
    }

    if (projectId && parent.projectId !== projectId) {
      throw new NotFoundException(
        'Parent node does not belong to this project',
      );
    }

    if (parent.isLocked) {
      throw new ForbiddenException(
        'Parent document is locked against modifications',
      );
    }

    const cleanTitle = sanitizeDocumentTitle(dto.title);
    const cleanSlug = slugifyTitle(cleanTitle);

    const created = await this.nodeRepo.createNode({
      title: cleanTitle,
      slug: cleanSlug,
      icon: dto.icon,
      content: dto.content !== undefined ? dto.content : Prisma.JsonNull,
      status: PageStatus.draft,
      rank: dto.rank ?? 0,
      project: { connect: { id: parent.projectId } },
      author: { connect: { id: userId } },
      parentPage: { connect: { id: parentNodeId } },
    });

    await this.invalidateTreeCache(parent.projectId);

    return { node: created };
  }

  /**
   * Retrieves direct children nodes of a given parent node.
   */
  async getChildren(parentNodeId: string, projectId?: string) {
    const parent = await this.nodeRepo.findNodeById(parentNodeId);
    if (!parent) {
      throw new NotFoundException(`Parent node ${parentNodeId} not found`);
    }

    if (projectId && parent.projectId !== projectId) {
      throw new NotFoundException(
        'Parent node does not belong to this project',
      );
    }

    const children = await this.nodeRepo.findDirectChildren(parentNodeId);
    return { children };
  }
}

export const TreeService = NodeService;
export type TreeService = NodeService;
