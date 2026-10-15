export const INGESTION_FACADE = 'INGESTION_FACADE';

export interface ReResolveMetadataOptions {
  doi?: string;
  arxivId?: string;
  pmid?: string;
  isbn?: string;
  title?: string;
  forceRefresh?: boolean;
  expectedVersion?: number;
  projectId?: string;
}

export interface IIngestionFacade {
  reResolveMetadata?(
    userId: string,
    itemId: string,
    options?: ReResolveMetadataOptions,
    projectId?: string,
  ): Promise<unknown>;
}
