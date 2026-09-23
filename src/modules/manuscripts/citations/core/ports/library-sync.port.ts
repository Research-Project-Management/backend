/**
 * citations/core/ports/library-sync.port.ts
 * Outbound SPI Port for synchronizing collections from Zotero / Flux Library.
 */

export const LIBRARY_SYNC_PORT = Symbol('LIBRARY_SYNC_PORT');

export interface LibraryCollectionSummary {
  id: string;
  name: string;
  itemCount: number;
}

export interface ILibrarySyncPort {
  /**
   * List accessible reference collections for a given user.
   */
  listCollections(userId: string): Promise<LibraryCollectionSummary[]>;

  /**
   * Fetch all items in a collection serialized as a clean BibTeX stream.
   */
  fetchCollectionBibtex(userId: string, collectionId: string): Promise<string>;
}
