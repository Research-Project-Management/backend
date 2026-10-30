import { RetractionBloomFilter } from '@/modules/library/ingestion/domain/retraction-bloom-filter.domain';

describe('RetractionBloomFilter', () => {
  it('should initialize with correct bit size and hash counts', () => {
    const filter = new RetractionBloomFilter(10000, 0.01);
    expect(filter.getItemCount()).toBe(0);
    expect(filter.isReady()).toBe(false);
    expect(filter.getMemorySizeBytes()).toBeGreaterThan(10000); // ~12 KB for 10k items
  });

  it('should guarantee ZERO false negatives (if added, contains MUST return true)', () => {
    const filter = new RetractionBloomFilter(5000, 0.01);
    const retractedDois = [
      '10.1016/s0140-6736(97)11096-0', // Wakefield MMR
      '10.1126/science.1105185',        // Hwang Woo-suk stem cells
      '10.1038/nature12968',            // Obokata STAP cells
      '10.1002/anie.201402233',
      '10.1101/2020.03.22.002386',
    ];

    for (const doi of retractedDois) {
      filter.add(doi);
    }
    filter.markReady(true);

    expect(filter.getItemCount()).toBe(5);
    expect(filter.isReady()).toBe(true);

    for (const doi of retractedDois) {
      expect(filter.contains(doi)).toBe(true);
      // Case-insensitivity check
      expect(filter.contains(doi.toUpperCase())).toBe(true);
    }
  });

  it('should return false for items not in the filter (Zero-False-Negative property)', () => {
    const filter = new RetractionBloomFilter(10000, 0.01);
    const addedDois = ['10.1000/1', '10.1000/2', '10.1000/3'];
    for (const doi of addedDois) {
      filter.add(doi);
    }

    expect(filter.contains('10.9999/clean-paper-1')).toBe(false);
    expect(filter.contains('10.9999/clean-paper-2')).toBe(false);
    expect(filter.contains('10.1234/completely-unrelated')).toBe(false);
  });

  it('should maintain false positive rate below configured threshold over 1,000 queries', () => {
    const n = 2000;
    const filter = new RetractionBloomFilter(n, 0.02); // 2% FP target

    // Add 2,000 DOIs
    for (let i = 0; i < n; i++) {
      filter.add(`10.1000/retracted-${i}`);
    }

    // Test with 1,000 distinct clean DOIs
    let falsePositives = 0;
    const testCount = 1000;
    for (let i = 0; i < testCount; i++) {
      if (filter.contains(`10.2000/clean-${i}`)) {
        falsePositives++;
      }
    }

    const observedFpRate = falsePositives / testCount;
    // Expected FP rate is ~0.02, allowing generous bound under 0.04
    expect(observedFpRate).toBeLessThan(0.04);
  });

  it('should handle empty/null/whitespace inputs gracefully', () => {
    const filter = new RetractionBloomFilter();
    expect(filter.contains('')).toBe(false);
    expect(filter.contains('   ')).toBe(false);
    filter.add('');
    filter.add('   ');
    expect(filter.getItemCount()).toBe(0);
  });

  it('should reset cleanly on clear()', () => {
    const filter = new RetractionBloomFilter();
    filter.add('10.1000/test');
    expect(filter.getItemCount()).toBe(1);

    filter.clear();
    expect(filter.getItemCount()).toBe(0);
    expect(filter.isReady()).toBe(false);
    expect(filter.contains('10.1000/test')).toBe(false);
  });
});
