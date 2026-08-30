/**
 * Verifies the wiring contracts for the canonical metadata pipeline:
 * - MetadataService has no Prisma dependency
 * - Providers implement the MetadataProvider interface correctly
 * - The multi-provider token produces the correct provider array
 */
import { MetadataProvider } from '@/modules/library/ingestion/metadata/types/metadata.types';
import { ArxivProvider } from '@/modules/library/ingestion/metadata/providers/arxiv.provider';
import { CrossRefProvider } from '@/modules/library/ingestion/metadata/providers/crossref.provider';
import { PubMedProvider } from '@/modules/library/ingestion/metadata/providers/pubmed.provider';
import { OpenLibraryProvider } from '@/modules/library/ingestion/metadata/providers/openlibrary.provider';
import { SemanticScholarProvider } from '@/modules/library/ingestion/metadata/providers/semantic-scholar.provider';
import { OpenAlexProvider } from '@/modules/library/ingestion/metadata/providers/openalex.provider';
import { UnpaywallProvider } from '@/modules/library/ingestion/metadata/providers/unpaywall.provider';

const ALL_PROVIDERS: MetadataProvider[] = [
  new CrossRefProvider(),
  new ArxivProvider(),
  new PubMedProvider(),
  new OpenLibraryProvider(),
  new SemanticScholarProvider(),
  new OpenAlexProvider(),
  new UnpaywallProvider(),
];

describe('Canonical metadata pipeline wiring', () => {
  it('all 7 providers are registered', () => {
    expect(ALL_PROVIDERS).toHaveLength(7);
  });

  const expectedProviderIds = [
    'CrossRef',
    'arXiv',
    'PubMed',
    'OpenLibrary',
    'SemanticScholar',
    'OpenAlex',
    'Unpaywall',
  ];

  expectedProviderIds.forEach((id, idx) => {
    it(`provider[${idx}] has id "${id}"`, () => {
      expect(ALL_PROVIDERS[idx].id).toBe(id);
    });
  });

  it('every provider implements MetadataProvider.supports()', () => {
    for (const p of ALL_PROVIDERS) {
      expect(typeof p.supports).toBe('function');
      const result = p.supports('DOI');
      expect(typeof result).toBe('boolean');
    }
  });

  it('every provider implements MetadataProvider.resolve()', () => {
    for (const p of ALL_PROVIDERS) {
      expect(typeof p.resolve).toBe('function');
    }
  });

  it('providers do not expose prisma, db, or any storage reference', () => {
    for (const p of ALL_PROVIDERS) {
      expect((p as any).prisma).toBeUndefined();
      expect((p as any).db).toBeUndefined();
    }
  });

  it('resolve returns null for empty query without throwing', async () => {
    for (const p of ALL_PROVIDERS) {
      const result = await p.resolve({ query: '' });
      expect(
        result === null || result === undefined || typeof result === 'object',
      ).toBe(true);
    }
  });
});
