import { ItemMetadata, CatalogItemSummary } from './items.types';

export interface CatalogItemDetail extends ItemMetadata {
  id: string;
  workspaceId: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date | null;
}

export interface CreateCatalogItemCommand {
  workspaceId: string;
  userId: string;
  metadata: ItemMetadata;
}

export interface UpdateCatalogItemCommand {
  workspaceId: string;
  itemId: string;
  metadata: Partial<ItemMetadata>;
  expectedVersion?: number;
}

export interface ICatalogCommitPort {
  createItem(command: CreateCatalogItemCommand): Promise<CatalogItemDetail>;
  updateItem(command: UpdateCatalogItemCommand): Promise<CatalogItemDetail>;
  softDeleteItem(workspaceId: string, itemId: string): Promise<void>;
  restoreItem(workspaceId: string, itemId: string): Promise<CatalogItemDetail>;
  purgeItem(workspaceId: string, itemId: string): Promise<void>;
}

export const CATALOG_COMMIT_PORT = Symbol('CATALOG_COMMIT_PORT');
export const ITEM_COMMIT_PORT = CATALOG_COMMIT_PORT;
export type IItemCommitPort = ICatalogCommitPort;

export interface ICatalogReadPort {
  findById(
    workspaceId: string,
    itemId: string,
  ): Promise<CatalogItemDetail | null>;
  findByIds(
    workspaceId: string,
    itemIds: string[],
  ): Promise<CatalogItemDetail[]>;
  findByDoi(
    workspaceId: string,
    doi: string,
  ): Promise<CatalogItemDetail | null>;
  findSummaryById(
    workspaceId: string,
    itemId: string,
  ): Promise<CatalogItemSummary | null>;
  findSummariesByIds(
    workspaceId: string,
    itemIds: string[],
  ): Promise<CatalogItemSummary[]>;
}

export const CATALOG_READ_PORT = Symbol('CATALOG_READ_PORT');
export const ITEM_READ_PORT = CATALOG_READ_PORT;
export type IItemReadPort = ICatalogReadPort;

export interface IItemExistencePort {
  exists(workspaceId: string, itemId: string): Promise<boolean>;
  assertExists(workspaceId: string, itemId: string): Promise<void>;
  existMany(
    workspaceId: string,
    itemIds: string[],
  ): Promise<Map<string, boolean>>;
}

export const ITEM_EXISTENCE_PORT = Symbol('ITEM_EXISTENCE_PORT');
