import {
  isValidFileHash,
  isValidMimeType,
  isPdfMimeType,
} from '@/modules/library/extraction';
import {
  IngestionRunAggregate,
  IngestionStatusVo,
} from '@/modules/library/ingestion/domain/ingestion-run.aggregate';
import { sanitizeSearchQuery } from '@/modules/library/search';
import {
  normalizeCitationStyleId,
  isSupportedCitationStyle,
} from '@/modules/library/citation';
import { compactLibraryChanges } from '@/modules/library/sync';

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
    it('sanitizeSearchQuery should sanitize tsquery special characters and whitespace', () => {
      const sanitized = sanitizeSearchQuery('  quantum & "computing":*  ');
      expect(sanitized).toBe('quantum computing');
      expect(sanitizeSearchQuery('')).toBe('');
      expect(sanitizeSearchQuery(undefined)).toBe('');
    });
  });

  describe('Citation Domain Logic', () => {
    it('normalizeCitationStyleId and isSupportedCitationStyle should normalize and fallback styles safely', () => {
      expect(normalizeCitationStyleId('APA')).toBe('apa');
      expect(normalizeCitationStyleId('nature')).toBe('nature');
      expect(isSupportedCitationStyle('ieee')).toBe(true);

      // Empty/invalid -> fallback 'apa-7th'
      expect(normalizeCitationStyleId(undefined)).toBe('apa-7th');
      expect(normalizeCitationStyleId('')).toBe('apa-7th');
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
