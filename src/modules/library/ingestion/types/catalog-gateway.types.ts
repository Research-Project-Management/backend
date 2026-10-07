export const CATALOG_GATEWAY_PORT = Symbol('CATALOG_GATEWAY_PORT');

export interface ICatalogGatewayPort {
  getItem(
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
    expectedVersion?: number,
    projectId?: string,
  ): Promise<any>;
  deleteItem(userId: string, itemId: string, projectId?: string): Promise<void>;
  findDuplicateCandidateItems(
    userId: string,
    limit?: number,
    projectId?: string,
  ): Promise<any[]>;
  findByIds(userId: string, ids: string[], projectId?: string): Promise<any[]>;
  mergeItems(
    tx: any,
    duplicateItemIds: string[],
    primaryItemId: string,
  ): Promise<void>;
  findQualityAuditItems(
    userId: string,
    limit?: number,
    projectId?: string,
  ): Promise<any[]>;
  getOrderedFields?(itemType: string): any[];
  getPrimaryCreatorType?(itemType: string): string;
  createNote?(userId: string, data: any): Promise<any>;
  itemExists?(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<boolean>;
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
  ): Promise<{
    exactMatch?: {
      id: string;
      title: string;
      matchReason: 'DOI_EXACT' | 'ARXIV_EXACT' | 'PMID_EXACT' | 'ISBN_EXACT';
      evidence: Record<string, any>;
    } | null;
    candidateItems: Array<{
      id: string;
      title: string;
      doi: string | null;
      year: number | null;
      citationKey: string | null;
      authors: string[];
    }>;
  }>;
}
