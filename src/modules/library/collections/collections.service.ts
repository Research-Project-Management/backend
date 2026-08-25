import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { CollectionsRepository } from './collections.repository';
import { BibtexFormatter } from '../citation/formatters/bibtex.formatter';
import {
  CreateCollectionDto,
  UpdateCollectionDto,
  ReorderItemDto,
  AssignPapersToCollectionDto,
} from './dto/collections.dto';

export type FormattedCollection<
  T extends {
    id: string;
    parentId?: string | null;
    _count?: { catalogItems?: number } | null;
  },
> = T & {
  parent?: string | null;
  itemsCount: number;
};

@Injectable()
export class CollectionsService {
  constructor(
    private readonly collectionRepo: CollectionsRepository,
    private readonly bibtexFormatter: BibtexFormatter,
  ) {}

  private formatCollection<
    T extends {
      id: string;
      parentId?: string | null;
      _count?: { catalogItems?: number } | null;
    },
  >(c: T): FormattedCollection<T>;
  private formatCollection(c: null | undefined): null;
  private formatCollection<
    T extends {
      id: string;
      parentId?: string | null;
      _count?: { catalogItems?: number } | null;
    },
  >(c: T | null | undefined): FormattedCollection<T> | null;
  private formatCollection<
    T extends {
      id: string;
      parentId?: string | null;
      _count?: { catalogItems?: number } | null;
    },
  >(c: T | null | undefined): FormattedCollection<T> | null {
    if (!c) return null;
    return {
      ...c,
      parent: c.parentId,
      itemsCount: c._count?.catalogItems ?? 0,
    };
  }

  async getCollections(workspaceId: string) {
    const targetWsId = await this.resolveWorkspaceId(workspaceId);
    const collections =
      await this.collectionRepo.findWorkspaceCollections(targetWsId);

    return {
      collections: collections.map((c) => this.formatCollection(c)),
    };
  }

  async getCollectionById(workspaceId: string, collectionId: string) {
    const collection = await this.getCollectionInWorkspace(
      workspaceId,
      collectionId,
    );

    return { collection: this.formatCollection(collection) };
  }

  async createCollection(
    workspaceId: string,
    userId: string,
    dto: CreateCollectionDto,
  ) {
    const targetWsId = await this.resolveWorkspaceId(workspaceId);

    const parentId = dto.parentId || dto.parent || null;
    if (parentId) {
      const parent = await this.collectionRepo.findCollectionById(parentId);
      if (!parent || parent.workspaceId !== targetWsId) {
        throw new NotFoundException('Parent collection not found in workspace');
      }
    }

    const collection = await this.collectionRepo.createCollection({
      name: dto.name,
      description: dto.description || '',
      color: dto.color || '#3370ff',
      icon: dto.icon || '',
      parentId,
      workspaceId: targetWsId,
      createdById: userId,
    });

    return { collection: this.formatCollection(collection) };
  }

  async updateCollection(
    workspaceId: string,
    collectionId: string,
    dto: UpdateCollectionDto,
  ) {
    const existing = await this.getCollectionInWorkspace(
      workspaceId,
      collectionId,
    );

    const parentId =
      dto.parentId !== undefined
        ? dto.parentId
        : dto.parent !== undefined
          ? dto.parent
          : undefined;

    if (parentId !== undefined && parentId !== null) {
      if (parentId === collectionId) {
        throw new BadRequestException('A collection cannot be its own parent');
      }

      await this.assertCollectionParentInWorkspace(
        parentId,
        existing.workspaceId,
      );
      await this.validateNoCircularHierarchy(
        collectionId,
        parentId,
        existing.workspaceId,
      );
    }

    const collection = await this.collectionRepo.updateCollection(
      collectionId,
      {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.color !== undefined && { color: dto.color }),
        ...(dto.icon !== undefined && { icon: dto.icon }),
        ...(parentId !== undefined && { parentId: parentId || null }),
      },
    );

    return { collection: this.formatCollection(collection) };
  }

  /**
   * Prevents circular parent-child relationships (e.g., A -> B -> A)
   */
  private async validateNoCircularHierarchy(
    collectionId: string,
    targetParentId: string,
    workspaceId: string,
  ) {
    const allCollections =
      await this.collectionRepo.findWorkspaceCollections(workspaceId);
    const map = new Map(allCollections.map((c) => [c.id, c.parentId]));

    let current: string | null | undefined = targetParentId;
    const visited = new Set<string>();

    while (current) {
      if (current === collectionId) {
        throw new BadRequestException(
          'Circular hierarchy detected: cannot set a collection as child of its own descendant',
        );
      }
      if (visited.has(current)) break;
      visited.add(current);
      current = map.get(current);
    }
  }

  async deleteCollection(
    workspaceId: string,
    collectionId: string,
    strategy: 'cascade' | 'move-to-parent' | 'orphan' = 'cascade',
  ) {
    const existing = await this.getCollectionInWorkspace(
      workspaceId,
      collectionId,
    );

    if (strategy === 'move-to-parent') {
      await this.collectionRepo.reparentChildren(
        collectionId,
        existing.parentId || null,
      );
    } else if (strategy === 'orphan') {
      await this.collectionRepo.reparentChildren(collectionId, null);
    }

    await this.collectionRepo.deleteCollection(collectionId);
    return { message: 'Collection deleted successfully' };
  }

  async movePapers(
    workspaceId: string,
    targetCollectionId: string | null,
    paperIds: string[],
  ) {
    const targetWsId = await this.resolveWorkspaceId(workspaceId);

    const normalizedTargetId =
      targetCollectionId === 'unfiled' ||
      targetCollectionId === 'root' ||
      !targetCollectionId
        ? null
        : targetCollectionId;

    if (normalizedTargetId) {
      const targetCol =
        await this.collectionRepo.findCollectionById(normalizedTargetId);
      if (!targetCol || targetCol.workspaceId !== targetWsId) {
        throw new NotFoundException('Target collection not found in workspace');
      }
    }

    const result = await this.collectionRepo.movePapers(
      targetWsId,
      normalizedTargetId,
      paperIds,
    );

    return {
      message: 'Papers moved successfully',
      count: result.count,
      targetCollectionId: normalizedTargetId,
    };
  }

  async reorderCollections(workspaceId: string, items: ReorderItemDto[]) {
    const targetWsId = await this.resolveWorkspaceId(workspaceId);

    for (const item of items) {
      if (item.parentId && item.parentId === item.id) continue;
      const existing = await this.collectionRepo.findCollectionById(item.id);
      if (!existing || existing.workspaceId !== targetWsId) {
        throw new NotFoundException('Collection not found in workspace');
      }

      if (item.parentId) {
        await this.assertCollectionParentInWorkspace(
          item.parentId,
          targetWsId,
        );
        await this.validateNoCircularHierarchy(
          item.id,
          item.parentId,
          targetWsId,
        );
      }

      await this.collectionRepo.updateCollection(item.id, {
        ...(item.parentId !== undefined && {
          parentId: item.parentId || null,
        }),
      });
    }

    return this.getCollections(targetWsId);
  }

  /**
   * Playlist Assignment: Link papers to collection
   */
  async assignPapersToCollection(
    workspaceId: string,
    collectionId: string,
    dto: AssignPapersToCollectionDto,
  ) {
    const targetWsId = await this.resolveWorkspaceId(workspaceId);

    const collection =
      await this.collectionRepo.findCollectionById(collectionId);
    if (!collection || collection.workspaceId !== targetWsId) {
      throw new NotFoundException('Collection not found in workspace');
    }

    const result = await this.collectionRepo.movePapers(
      targetWsId,
      collectionId,
      dto.itemIds || dto.paperIds || [],
    );

    return {
      message: 'Papers linked to collection successfully',
      count: result.count,
      collectionId,
    };
  }

  /**
   * Soft-Detach: Remove paper from collection without deleting paper record from Library
   */
  async detachPaperFromCollection(
    workspaceId: string,
    collectionId: string,
    paperId: string,
  ) {
    const targetWsId = await this.resolveWorkspaceId(workspaceId);

    const collection =
      await this.collectionRepo.findCollectionById(collectionId);
    if (!collection || collection.workspaceId !== targetWsId) {
      throw new NotFoundException('Collection not found in workspace');
    }

    const result = await this.collectionRepo.detachPaperFromCollection(
      targetWsId,
      collectionId,
      paperId,
    );

    if (result.count === 0) {
      throw new NotFoundException('Paper not found in this collection');
    }

    return {
      message: 'Paper detached from collection successfully',
      count: result.count,
    };
  }

  /**
   * Project/Collection-scoped BibTeX export
   */
  async exportCollectionBibtex(
    workspaceId: string,
    collectionId: string,
  ): Promise<{ bibtex: string; total: number; filename: string }> {
    const targetWsId = await this.resolveWorkspaceId(workspaceId);

    const collection =
      await this.collectionRepo.findCollectionById(collectionId);
    if (!collection || collection.workspaceId !== targetWsId) {
      throw new NotFoundException('Collection not found in workspace');
    }

    const papers = await this.collectionRepo.findPapersInCollection(
      targetWsId,
      collectionId,
    );

    const bibtex = this.bibtexFormatter.formatMultiple(papers);
    const filename = `collection-${collectionId}.bib`;

    return {
      bibtex,
      total: papers.length,
      filename,
    };
  }

  /**
   * Generates a complete collection export bundle (BibTeX + Manifest of all PDFs)
   */
  async getCollectionExportBundle(workspaceId: string, collectionId: string) {
    const targetWsId = await this.resolveWorkspaceId(workspaceId);

    const collection =
      await this.collectionRepo.findCollectionById(collectionId);
    if (!collection || collection.workspaceId !== targetWsId) {
      throw new NotFoundException('Collection not found in workspace');
    }

    const papers = await this.collectionRepo.findPapersInCollection(
      targetWsId,
      collectionId,
      true, // include attachments
    );

    const bibtex = this.bibtexFormatter.formatMultiple(papers);

    const files = papers
      .map((p) => ({
        paperId: p.id,
        title: p.title,
        citationKey: p.citationKey || '',
        fileUrl: p.fileUrl || '',
        filename: p.filename || `${p.citationKey || p.id}.pdf`,
        attachments: p.attachments,
      }))
      .filter((p) => Boolean(p.fileUrl || p.attachments.length > 0));

    return {
      collection: {
        id: collection.id,
        name: collection.name,
      },
      totalPapers: papers.length,
      totalFiles: files.length,
      bibtex,
      files,
    };
  }

  private async resolveWorkspaceId(workspaceId: string): Promise<string> {
    const ws = await this.collectionRepo.resolveWorkspace(workspaceId);
    return ws?.id || workspaceId;
  }

  private async getCollectionInWorkspace(
    workspaceId: string,
    collectionId: string,
  ) {
    const targetWsId = await this.resolveWorkspaceId(workspaceId);
    const collection =
      await this.collectionRepo.findCollectionById(collectionId);

    if (!collection || collection.workspaceId !== targetWsId) {
      throw new NotFoundException('Collection not found in workspace');
    }

    return collection;
  }

  private async assertCollectionParentInWorkspace(
    parentId: string,
    workspaceId: string,
  ) {
    const parent = await this.collectionRepo.findCollectionById(parentId);
    if (!parent || parent.workspaceId !== workspaceId) {
      throw new NotFoundException('Parent collection not found in workspace');
    }
  }
}
