import {
  calculateTokenSortRatio,
  calculateTitleSimilarity,
  tokenizeTitleWords,
  jaroWinkler,
  firstAuthorMatches,
} from '@/modules/library/ingestion/core/domain/deduplication.utils';
import {
  compactLibraryChanges,
  CompactableChange,
} from '@/modules/library/sync/core/domain/outbox.utils';

describe('Library Redesign Algorithms — Deduplication & Sync Compaction Suite', () => {
  describe('Algorithm 1: Advanced Token Sort Ratio & Word Normalization', () => {
    it('should tokenize titles, stripping stop-words and punctuation cleanly', () => {
      const tokens = tokenizeTitleWords(
        'A Comprehensive Survey on Deep Learning: Applications & Challenges',
      );
      expect(tokens).toEqual([
        'comprehensive',
        'survey',
        'deep',
        'learning',
        'applications',
        'challenges',
      ]);
    });

    it('should detect identical titles regardless of word order (Transposed titles)', () => {
      const titleA = 'Deep Learning: A Comprehensive Survey';
      const titleB = 'A Comprehensive Survey on Deep Learning';
      const score = calculateTokenSortRatio(titleA, titleB);
      expect(score).toBeGreaterThanOrEqual(0.95);
    });

    it('should match titles with punctuation and LaTeX formatting differences', () => {
      const titleA = 'Attention Is All You Need!';
      const titleB = 'Attention is all you need';
      expect(calculateTokenSortRatio(titleA, titleB)).toBe(1.0);

      const titleMathA = 'Efficient Calculation of $\\alpha$-Divergence';
      const titleMathB = 'Efficient calculation of alpha divergence';
      expect(
        calculateTitleSimilarity(titleMathA, titleMathB),
      ).toBeGreaterThanOrEqual(0.85);
    });

    it('should accurately compare author family names with Jaro-Winkler', () => {
      expect(jaroWinkler('hinton', 'hinton')).toBe(1.0);
      expect(firstAuthorMatches('Bengio, Yoshua', 'Bengio')).toBe(true);
      expect(firstAuthorMatches('LeCun', 'Lecun')).toBe(true);
      expect(firstAuthorMatches('Vaswani', 'Smith')).toBe(false);
    });
  });

  describe('Algorithm 2: Sliding-Window Delta Compaction for Sync Protocol', () => {
    it('should cancel out ephemeral entities created and deleted in the same sync window', () => {
      const changes: CompactableChange[] = [
        {
          seq: 101n,
          entityType: 'item',
          entityId: 'item-1',
          action: 'CREATE',
          data: { title: 'Temporary Item' },
        },
        {
          seq: 102n,
          entityType: 'item',
          entityId: 'item-1',
          action: 'DELETE',
        },
      ];

      const compacted = compactLibraryChanges(changes);
      expect(compacted).toHaveLength(0);
    });

    it('should squash multiple consecutive updates into a single update with merged payload', () => {
      const changes: CompactableChange[] = [
        {
          seq: 201n,
          entityType: 'item',
          entityId: 'item-2',
          action: 'UPDATE',
          data: { title: 'First Title' },
        },
        {
          seq: 202n,
          entityType: 'item',
          entityId: 'item-2',
          action: 'UPDATE',
          data: { year: 2024 },
        },
        {
          seq: 203n,
          entityType: 'item',
          entityId: 'item-2',
          action: 'UPDATE',
          data: { title: 'Refined Title', doi: '10.1234/test' },
        },
      ];

      const compacted = compactLibraryChanges(changes);
      expect(compacted).toHaveLength(1);
      expect(compacted[0].action).toBe('UPDATE');
      expect(compacted[0].seq).toBe(203n);
      expect(compacted[0].data).toEqual({
        title: 'Refined Title',
        year: 2024,
        doi: '10.1234/test',
      });
    });

    it('should maintain CREATE action when an item is created then updated multiple times', () => {
      const changes: CompactableChange[] = [
        {
          seq: 301n,
          entityType: 'collection',
          entityId: 'col-1',
          action: 'CREATE',
          data: { name: 'Initial Collection' },
        },
        {
          seq: 302n,
          entityType: 'collection',
          entityId: 'col-1',
          action: 'UPDATE',
          data: { color: '#ff0000' },
        },
      ];

      const compacted = compactLibraryChanges(changes);
      expect(compacted).toHaveLength(1);
      expect(compacted[0].action).toBe('CREATE');
      expect(compacted[0].seq).toBe(302n);
      expect(compacted[0].data).toEqual({
        name: 'Initial Collection',
        color: '#ff0000',
      });
    });

    it('should sort final compacted changes monotonically by sequence number', () => {
      const changes: CompactableChange[] = [
        {
          seq: 500n,
          entityType: 'tag',
          entityId: 'tag-2',
          action: 'CREATE',
          data: { name: 'Tag B' },
        },
        {
          seq: 100n,
          entityType: 'tag',
          entityId: 'tag-1',
          action: 'CREATE',
          data: { name: 'Tag A' },
        },
      ];

      const compacted = compactLibraryChanges(changes);
      expect(compacted).toHaveLength(2);
      expect(compacted[0].entityId).toBe('tag-1');
      expect(compacted[1].entityId).toBe('tag-2');
    });
  });
});
