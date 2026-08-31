import { ItemMetadata } from '../types/item.types';
import { CatalogItemDetail } from './catalog-read.port';

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
