export const FULLTEXT_QUERY_PORT = Symbol('FULLTEXT_QUERY_PORT');

export interface FulltextSourceRecord {
  rawPayload?: unknown;
}

export interface FulltextItemSummary {
  title: string;
  abstract?: string | null;
}

export interface IFulltextQueryPort {
  findById(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<FulltextItemSummary | null>;
  findMetadataSourceRecord(
    itemId: string,
    source: string,
  ): Promise<FulltextSourceRecord | null>;
}
