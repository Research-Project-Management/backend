import { Injectable, Inject, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ICatalogGatewayPort } from '@/modules/library/ingestion/types/catalog-gateway.types';
import {
  CATALOG_FACADE,
  ICatalogFacade,
} from '@/modules/library/shared-kernel';
import {
  CreateItemData,
  UpdateItemData,
  CreateNoteData,
  NoteEntity,
  ItemDetail,
  DuplicateCandidateItem,
} from '@/modules/library/catalog';
import { ItemFieldDefinition } from '@/modules/library/shared-kernel';

/**
 * In-process adapter connecting Ingestion to Catalog via CatalogFacade.
 * When separating into independent microservices, this adapter is replaced by HttpCatalogGatewayAdapter.
 */
@Injectable()
export class InProcessCatalogGatewayAdapter implements ICatalogGatewayPort {
  constructor(
    @Optional()
    @Inject(CATALOG_FACADE)
    private readonly catalogFacade?: ICatalogFacade,
  ) {}

  getItem(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<ItemDetail | null> {
    if (!this.catalogFacade) return Promise.resolve(null);
    return this.catalogFacade.getItem(userId, itemId, projectId);
  }

  createItem(
    userId: string,
    data: CreateItemData,
    options?: {
      expectedVersion?: number;
      suppressIndexing?: boolean;
      projectId?: string;
      source?: string;
      idempotencyKey?: string;
      correlationId?: string;
    },
    projectId?: string,
  ): Promise<ItemDetail> {
    if (!this.catalogFacade) {
      throw new Error('CatalogGateway: CatalogFacade is unavailable');
    }
    return this.catalogFacade.createItem(userId, data, options, projectId);
  }

  updateItem(
    userId: string,
    itemId: string,
    data: UpdateItemData,
    expectedVersion?: number,
    projectId?: string,
  ): Promise<ItemDetail> {
    if (!this.catalogFacade) {
      throw new Error('CatalogGateway: CatalogFacade is unavailable');
    }
    return this.catalogFacade.updateItem(userId, itemId, data, {
      expectedVersion,
      projectId,
    });
  }

  deleteItem(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<void> {
    if (!this.catalogFacade) {
      throw new Error('CatalogGateway: CatalogFacade is unavailable');
    }
    return this.catalogFacade.deleteItem(userId, itemId, projectId);
  }

  findDuplicateCandidateItems(
    userId: string,
    limit?: number,
    projectId?: string,
  ): Promise<DuplicateCandidateItem[]> {
    if (!this.catalogFacade?.findDuplicateCandidateItems)
      return Promise.resolve([]);
    return this.catalogFacade.findDuplicateCandidateItems(
      userId,
      limit,
      projectId,
    );
  }

  findByIds(
    userId: string,
    ids: string[],
    projectId?: string,
  ): Promise<ItemDetail[]> {
    if (!this.catalogFacade) return Promise.resolve([]);
    return this.catalogFacade.findByIds(userId, ids, projectId);
  }

  async mergeItems(
    tx: Prisma.TransactionClient,
    duplicateItemIds: string[],
    primaryItemId: string,
  ): Promise<void> {
    if (!this.catalogFacade?.mergeItems) {
      throw new Error('CatalogGateway: CatalogFacade is unavailable');
    }
    await this.catalogFacade.mergeItems(tx, duplicateItemIds, primaryItemId);
  }

  findQualityAuditItems(
    userId: string,
    limit?: number,
    projectId?: string,
  ): Promise<ItemDetail[]> {
    if (!this.catalogFacade?.findQualityAuditItems) return Promise.resolve([]);
    return this.catalogFacade.findQualityAuditItems(userId, limit, projectId);
  }

  getOrderedFields(itemType: string): ItemFieldDefinition[] {
    if (!this.catalogFacade || !this.catalogFacade.getOrderedFields) return [];
    return this.catalogFacade.getOrderedFields(itemType);
  }

  getPrimaryCreatorType(itemType: string): string {
    if (!this.catalogFacade || !this.catalogFacade.getPrimaryCreatorType) {
      return 'author';
    }
    return this.catalogFacade.getPrimaryCreatorType(itemType);
  }

  createNote(userId: string, data: CreateNoteData): Promise<NoteEntity> {
    if (this.catalogFacade?.createNote) {
      return this.catalogFacade.createNote(userId, data);
    }
    return Promise.reject(
      new Error('CatalogGateway: createNote is unavailable'),
    );
  }

  itemExists(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<boolean> {
    if (this.catalogFacade?.itemExists) {
      return this.catalogFacade.itemExists(userId, itemId, projectId);
    }
    return Promise.resolve(false);
  }

  async findMatchCandidates(
    scope: { userId?: string; projectId?: string | null } | string,
    criteria: {
      doi?: string | null;
      arxivId?: string | null;
      pmid?: string | null;
      isbn?: string | null;
      titleWords?: string[];
      titlePrefix?: string;
    },
  ) {
    if (this.catalogFacade?.findMatchCandidates) {
      return this.catalogFacade.findMatchCandidates(scope, criteria);
    }
    return { exactMatch: null, candidateItems: [] };
  }
}
