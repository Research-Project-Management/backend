import { Injectable, NotFoundException } from '@nestjs/common';
import { CollectionRepository } from './collection.repository';
import { CreateCollectionDto, UpdateCollectionDto } from './dto/collection.dto';

export type FormattedCollection<
  T extends {
    id: string;
    parentId?: string | null;
    _count?: { papers?: number } | null;
  },
> = T & {
  parent?: string | null;
  papersCount: number;
};

@Injectable()
export class CollectionService {
  constructor(private readonly collectionRepo: CollectionRepository) {}

  private formatCollection<
    T extends {
      id: string;
      parentId?: string | null;
      _count?: { papers?: number } | null;
    },
  >(c: T): FormattedCollection<T>;
  private formatCollection(c: null | undefined): null;
  private formatCollection<
    T extends {
      id: string;
      parentId?: string | null;
      _count?: { papers?: number } | null;
    },
  >(c: T | null | undefined): FormattedCollection<T> | null;
  private formatCollection<
    T extends {
      id: string;
      parentId?: string | null;
      _count?: { papers?: number } | null;
    },
  >(c: T | null | undefined): FormattedCollection<T> | null {
    if (!c) return null;
    return {
      ...c,
      parent: c.parentId,
      papersCount: c._count?.papers ?? 0,
    };
  }

  async getCollections(workspaceId: string) {
    const collections =
      await this.collectionRepo.findWorkspaceCollections(workspaceId);

    return {
      collections: collections.map((c) => this.formatCollection(c)),
    };
  }

  async getCollectionById(collectionId: string) {
    const collection =
      await this.collectionRepo.findCollectionById(collectionId);

    if (!collection) {
      throw new NotFoundException('Collection not found');
    }

    return { collection: this.formatCollection(collection) };
  }

  async createCollection(
    workspaceId: string,
    userId: string,
    dto: CreateCollectionDto,
  ) {
    const parentId = dto.parentId || dto.parent || null;
    const collection = await this.collectionRepo.createCollection({
      name: dto.name,
      description: dto.description || '',
      color: dto.color || '#3370ff',
      icon: dto.icon || '',
      parentId,
      workspaceId,
      createdById: userId,
    });

    return { collection: this.formatCollection(collection) };
  }

  async updateCollection(collectionId: string, dto: UpdateCollectionDto) {
    const parentId =
      dto.parentId !== undefined
        ? dto.parentId
        : dto.parent !== undefined
          ? dto.parent
          : undefined;

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

  async deleteCollection(collectionId: string) {
    await this.collectionRepo.deleteCollection(collectionId);
    return { message: 'Collection deleted successfully' };
  }
}
