/**
 * SearchQuery Value Object.
 * Enforces query bounds, pagination limits (max 100), and sanitization.
 */
export class SearchQueryVo {
  private readonly _query: string;
  private readonly _limit: number;
  private readonly _offset: number;
  private readonly _sortBy: 'relevance' | 'date' | 'title';

  private constructor(props: {
    query: string;
    limit: number;
    offset: number;
    sortBy: 'relevance' | 'date' | 'title';
  }) {
    this._query = props.query;
    this._limit = props.limit;
    this._offset = props.offset;
    this._sortBy = props.sortBy;
  }

  public static create(
    rawQuery: string,
    options?: { limit?: number; offset?: number; sortBy?: string },
  ): SearchQueryVo {
    const trimmed = (rawQuery ?? '').trim();
    const limit = Math.min(100, Math.max(1, options?.limit ?? 20));
    const offset = Math.max(0, options?.offset ?? 0);
    const sortBy =
      options?.sortBy === 'date' || options?.sortBy === 'title'
        ? options.sortBy
        : 'relevance';

    return new SearchQueryVo({
      query: trimmed,
      limit,
      offset,
      sortBy,
    });
  }

  public get query(): string {
    return this._query;
  }
  public get limit(): number {
    return this._limit;
  }
  public get offset(): number {
    return this._offset;
  }
  public get sortBy(): 'relevance' | 'date' | 'title' {
    return this._sortBy;
  }
}
