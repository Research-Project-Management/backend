import { CatalogItemSummary, ItemMetadata } from '../types/item.types';

export interface CatalogItemDetail extends ItemMetadata {
  id: string;
  workspaceId: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date | null;
}

export interface ICatalogReadPort {
  findById(workspaceId: string, itemId: string): Promise<CatalogItemDetail | null>;
  findByIds(workspaceId: string, itemIds: string[]): Promise<CatalogItemDetail[]>;
  findByDoi(workspaceId: string, doi: string): Promise<CatalogItemDetail | null>;
  findSummaryById(workspaceId: string, itemId: string): Promise<CatalogItemSummary | null>;
  findSummariesByIds(workspaceId: string, itemIds: string[]): Promise<CatalogItemSummary[]>;
}

export const CATALOG_READ_PORT = Symbol('CATALOG_READ_PORT');
