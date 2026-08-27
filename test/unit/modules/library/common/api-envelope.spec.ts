import {
  wrapResponse,
  createPaginationMeta,
} from '@/modules/library/legacy/sync/utils/sync.util';

describe('API Envelope & Pagination Utilities (Sync & Subsystem)', () => {
  describe('wrapResponse', () => {
    it('wraps simple data with default metadata', () => {
      const data = { id: 'item-1', title: 'Research Paper' };
      const res = wrapResponse(data);

      expect(res.data).toEqual(data);
      expect(res.meta?.version).toBe('v1');
      expect(res.meta?.timestamp).toBeDefined();
      expect(res.pagination).toBeUndefined();
    });

    it('wraps paginated data with pagination metadata', () => {
      const data = [{ id: 'item-1' }, { id: 'item-2' }];
      const pagination = createPaginationMeta(100, 2, 20);
      const res = wrapResponse(data, pagination, { customTag: 'test' });

      expect(res.data).toEqual(data);
      expect(res.pagination?.page).toBe(2);
      expect(res.pagination?.limit).toBe(20);
      expect(res.pagination?.total).toBe(100);
      expect(res.pagination?.totalPages).toBe(5);
      expect(res.pagination?.hasMore).toBe(true);
      expect(res.meta?.customTag).toBe('test');
    });
  });

  describe('createPaginationMeta', () => {
    it('calculates totalPages and hasMore correctly for middle page', () => {
      const meta = createPaginationMeta(45, 2, 10);
      expect(meta.totalPages).toBe(5);
      expect(meta.hasMore).toBe(true);
    });

    it('calculates hasMore false for last page', () => {
      const meta = createPaginationMeta(45, 5, 10);
      expect(meta.totalPages).toBe(5);
      expect(meta.hasMore).toBe(false);
    });

    it('handles zero total records safely', () => {
      const meta = createPaginationMeta(0, 1, 20);
      expect(meta.totalPages).toBe(0);
      expect(meta.hasMore).toBe(false);
    });
  });
});
