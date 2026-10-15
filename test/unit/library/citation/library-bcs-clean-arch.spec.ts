import {
  isValidFileHash,
  isValidMimeType,
  isPdfMimeType,
} from '@/modules/library/extraction/domain';
import { IngestionStatusVo } from '@/modules/library/ingestion/domain/ingestion-status.vo';
import { IngestionRunAggregate } from '@/modules/library/ingestion/domain/ingestion-run.aggregate';
import {
  SearchQueryVo,
  createSearchQuery,
} from '@/modules/library/search/domain';
import { CitationStyleVo } from '@/modules/library/citation/domain';
import { compactLibraryChanges } from '@/modules/library/sync/domain';

describe('Library Bounded Contexts - Modular Monolith Domain Logic', () => {
  describe('Extraction Domain Logic', () => {
    it('isValidFileHash should validate MD5 and SHA-256 hex formats', () => {
      const validMd5 = 'd41d8cd98f00b204e9800998ecf8427e';
      const validSha256 =
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

      expect(isValidFileHash(validMd5)).toBe(true);
      expect(isValidFileHash(validSha256)).toBe(true);
      expect(isValidFileHash('not-a-valid-hex-hash')).toBe(false);
      expect(isValidFileHash(null)).toBe(false);
    });

    it('isValidMimeType and isPdfMimeType should validate MIME types', () => {
      expect(isValidMimeType('application/pdf')).toBe(true);
      expect(isPdfMimeType('application/pdf')).toBe(true);
      expect(isPdfMimeType('application/json')).toBe(false);
      expect(isValidMimeType('invalid_mime')).toBe(false);
    });
  });

  describe('Ingestion Domain Logic', () => {
    it('IngestionStatusVo should enforce valid state transitions', () => {
      const pending = IngestionStatusVo.create('PENDING');
      const running = IngestionStatusVo.create('RUNNING');
      const completed = IngestionStatusVo.create('COMPLETED');

      expect(pending.canTransitionTo(running)).toBe(true);
      expect(pending.canTransitionTo(completed)).toBe(false); // Cannot jump directly to completed
      expect(running.canTransitionTo(completed)).toBe(true);
      expect(completed.canTransitionTo(running)).toBe(false); // Terminal state
    });

    it('IngestionRunAggregate should manage pipeline lifecycle and record progress', () => {
      const run = IngestionRunAggregate.create({
        userId: 'user-1',
        sourceType: 'bibtex',
        totalItems: 10,
      });

      expect(run.status).toBe('RUNNING');
      expect(run.totalItems).toBe(10);
      expect(run.processedItems).toBe(0);

      run.recordProgress(5, 0);
      expect(run.processedItems).toBe(5);

      run.complete();
      expect(run.status).toBe('COMPLETED');
      expect(run.completedAt).toBeDefined();
    });
  });

  describe('Search Domain Logic', () => {
    it('createSearchQuery and SearchQueryVo should enforce limits and sanitize parameters', () => {
      const sanitized = createSearchQuery('  quantum computing  ', {
        limit: 500, // Should be clamped to 100
        offset: -10, // Should be clamped to 0
        sortBy: 'date',
      });

      expect(sanitized.query).toBe('quantum computing');
      expect(sanitized.limit).toBe(100);
      expect(sanitized.offset).toBe(0);
      expect(sanitized.sortBy).toBe('date');

      const queryVo = SearchQueryVo.create('  quantum computing  ', {
        limit: 500,
        offset: -10,
        sortBy: 'date',
      });
      expect(queryVo.query).toBe('quantum computing');
      expect(queryVo.limit).toBe(100);
      expect(queryVo.offset).toBe(0);
      expect(queryVo.sortBy).toBe('date');
    });
  });

  describe('Citation Domain Logic', () => {
    it('CitationStyleVo should normalize and fallback styles safely', () => {
      const apa = CitationStyleVo.create('APA');
      expect(apa.value).toBe('apa');

      // CitationStyleVo uses open CSL model: any valid slug is accepted
      const customStyle = CitationStyleVo.create('nature');
      expect(customStyle.value).toBe('nature');

      // Null/empty -> fallback 'apa'
      expect(CitationStyleVo.create(null).value).toBe('apa');
      expect(CitationStyleVo.create('').value).toBe('apa');
    });
  });

  describe('Sync Domain Logic', () => {
    it('compactLibraryChanges should squash redundant intermediate updates', () => {
      const changes = [
        {
          id: '1',
          seq: 1,
          entityType: 'item',
          entityId: 'item-1',
          action: 'CREATE',
          data: { title: 'Initial' },
        },
        {
          id: '2',
          seq: 2,
          entityType: 'item',
          entityId: 'item-1',
          action: 'UPDATE',
          data: { year: 2026 },
        },
      ];

      const compacted = compactLibraryChanges(changes);
      expect(compacted).toHaveLength(1);
      expect(compacted[0].action).toBe('CREATE');
      expect(compacted[0].data).toEqual({ title: 'Initial', year: 2026 });
    });
  });
});
