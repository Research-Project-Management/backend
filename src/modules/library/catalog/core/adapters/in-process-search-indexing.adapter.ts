import { Injectable, Inject, Optional } from '@nestjs/common';
import {
  SEARCH_INDEXING_PORT,
  ISearchIndexingPort,
} from '../ports/search-indexing.port';
import { SEARCH_FACADE, ISearchFacade } from '../../../search/search.facade';

/**
 * In-process adapter connecting Catalog to Search via SearchFacade.
 * When Search is separated into an independent microservice, this adapter is replaced by
 * an asynchronous event-driven adapter or HttpSearchIndexingAdapter.
 */
@Injectable()
export class InProcessSearchIndexingAdapter implements ISearchIndexingPort {
  constructor(
    @Optional()
    @Inject(SEARCH_FACADE)
    private readonly searchFacade?: ISearchFacade,
  ) {}

  async reindexItem(item: any): Promise<void> {
    if (this.searchFacade?.reindexItem) {
      await this.searchFacade.reindexItem(item);
    }
  }
}
