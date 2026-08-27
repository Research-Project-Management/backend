import 'reflect-metadata';
import { CursorUtil } from '@/modules/library/legacy/items/dto/cursor-pagination.dto';

describe('Library Cursor Pagination & Concurrency', () => {
  describe('Cursor Pagination Util', () => {
    it('should encode and decode opaque cursors deterministically', () => {
      const id = 'item-abc-123';
      const timestamp = 1719999999000;
      const cursor = CursorUtil.encode(id, timestamp);

      expect(typeof cursor).toBe('string');
      const decoded = CursorUtil.decode(cursor);

      expect(decoded).not.toBeNull();
      expect(decoded?.id).toBe(id);
      expect(decoded?.timestamp).toBe(timestamp);
    });

    it('should return null for malformed cursor strings', () => {
      expect(CursorUtil.decode('invalid-base64-!@#$')).toBeNull();
    });
  });
});
