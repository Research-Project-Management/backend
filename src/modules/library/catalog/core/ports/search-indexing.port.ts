/**
 * Search Indexing Gateway Port — Catalog Bounded Context
 *
 * Defines the contract through which Catalog requests search re-indexing.
 * In monolith: implemented by InProcessSearchIndexingAdapter (delegates to SearchFacade).
 * In microservices: implemented by EventSearchIndexingAdapter (publishes event to message broker)
 * or HttpSearchIndexingAdapter.
 */
export const SEARCH_INDEXING_PORT = Symbol('SEARCH_INDEXING_PORT');

export interface ISearchIndexingPort {
  reindexItem(item: any): Promise<void>;
}
