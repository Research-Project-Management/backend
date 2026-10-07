export const CATALOG_FACADE = 'CATALOG_FACADE';

export interface ICatalogFacade {
  getItem(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<any | null>;
  getItemSummary(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<any | null>;
  itemExists(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<boolean>;
  getTags(
    userId: string,
    options?: { includeInactive?: boolean; projectId?: string },
  ): Promise<any[]>;
  getItemState(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<any | null>;
  createItem(
    userId: string,
    data: any,
    options?: any,
    projectId?: string,
  ): Promise<any>;
  updateItem(
    userId: string,
    itemId: string,
    data: any,
    options?: { expectedVersion?: number; projectId?: string },
  ): Promise<any>;
  deleteItem(userId: string, itemId: string, projectId?: string): Promise<void>;
  findByIds(
    userId: string,
    itemIds: string[],
    projectId?: string,
  ): Promise<any[]>;
  countItems(userId: string, options?: any): Promise<number>;
  findMany(userId: string, options?: any): Promise<any[]>;
  validateItemType?(type: string): Promise<boolean>;
  getPrimaryCreatorType?(itemType: string): string;
  getOrderedFields?(itemType: string): any[];
  findQualityAuditItems?(
    userId: string,
    limit?: number,
    projectId?: string,
  ): Promise<any[]>;
  findDuplicateCandidateItems?(
    userId: string,
    limit?: number,
    projectId?: string,
  ): Promise<any[]>;
  mergeItems?(
    tx: any,
    duplicateItemIds: string[],
    primaryItemId: string,
  ): Promise<any>;
  createNote?(userId: string, data: any): Promise<any>;
  findMatchCandidates?(
    scope: { userId?: string; projectId?: string | null } | string,
    criteria: {
      doi?: string | null;
      arxivId?: string | null;
      pmid?: string | null;
      isbn?: string | null;
      titleWords?: string[];
      titlePrefix?: string;
    },
  ): Promise<{ exactMatch: any; candidateItems: any[] }>;
  [key: string]: any;
}
