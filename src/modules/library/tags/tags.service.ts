import { Injectable } from '@nestjs/common';
import { TagsRepository } from './tags.repository';
import { LibraryTransactionService } from '../sync-core/library-transaction.service';

@Injectable()
export class TagsService {
  constructor(
    private readonly tagsRepo: TagsRepository,
    private readonly libraryTx: LibraryTransactionService,
  ) {}

  async getTags(workspaceId: string) {
    return this.tagsRepo.findMany(workspaceId);
  }

  async createOrGetTag(
    workspaceId: string,
    name: string,
    color?: string,
    type?: string,
  ) {
    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      const tag = await this.tagsRepo.create(
        workspaceId,
        name.trim(),
        color,
        type,
        tx,
      );

      await helpers.appendChange(workspaceId, {
        entityType: 'Tag',
        entityId: tag.id,
        action: 'create',
        version: 1,
        data: tag,
      });

      await helpers.publishOutbox(
        workspaceId,
        tag.id,
        'library.tag.created',
        tag,
      );

      return tag;
    });
  }

  async deleteTag(workspaceId: string, tagId: string) {
    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      const deleted = await this.tagsRepo.delete(workspaceId, tagId, tx);
      if (deleted) {
        await helpers.recordTombstone(workspaceId, {
          entityType: 'Tag',
          entityId: tagId,
        });

        await helpers.publishOutbox(workspaceId, tagId, 'library.tag.deleted', {
          id: tagId,
          deletedAt: new Date(),
        });
      }
      return deleted;
    });
  }

  async assignTag(workspaceId: string, tagId: string, catalogItemId: string) {
    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      await this.tagsRepo.assignToItem(tagId, catalogItemId, tx);

      await helpers.appendChange(workspaceId, {
        entityType: 'CatalogItemTag',
        entityId: `${tagId}:${catalogItemId}`,
        action: 'create',
        version: 1,
        data: { tagId, catalogItemId },
      });

      await helpers.publishOutbox(
        workspaceId,
        catalogItemId,
        'library.item.tagged',
        { tagId, catalogItemId },
      );
    });
  }

  async removeTag(workspaceId: string, tagId: string, catalogItemId: string) {
    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      await this.tagsRepo.removeFromItem(tagId, catalogItemId, tx);

      await helpers.recordTombstone(workspaceId, {
        entityType: 'CatalogItemTag',
        entityId: `${tagId}:${catalogItemId}`,
      });

      await helpers.publishOutbox(
        workspaceId,
        catalogItemId,
        'library.item.untagged',
        { tagId, catalogItemId },
      );
    });
  }
}
