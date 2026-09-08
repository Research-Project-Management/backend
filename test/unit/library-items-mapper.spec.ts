import { ItemsMapper } from '../../src/modules/library/items/mappers/items.mapper';
import { CslJsonMapper } from '../../src/modules/library/citation/mappers/csl-json.mapper';
import {
  CATALOG_COLUMN_METADATA_FIELDS,
  TYPE_SPECIFIC_EXTRA_FIELDS,
  FIELD_ALIASES,
  REVERSE_FIELD_ALIASES,
} from '../../src/modules/library/items/constants/items.constants';

describe('Library Canonical Reconstruction Suite (Batch 11)', () => {
  describe('Prisma Columns & Metadata Constants Parity', () => {
    it('should include all physical CatalogItem columns in CATALOG_COLUMN_METADATA_FIELDS', () => {
      const physicalColumns = [
        'title',
        'year',
        'doi',
        'abstract',
        'itemType',
        'publicationTitle',
        'publicationDate',
        'publisher',
        'place',
        'volume',
        'issue',
        'section',
        'partNumber',
        'partTitle',
        'pages',
        'series',
        'seriesTitle',
        'seriesText',
        'seriesNumber',
        'issn',
        'isbn',
        'pmid',
        'pmcid',
        'url',
        'language',
        'journalAbbr',
        'shortTitle',
        'rights',
        'license',
        'citationKey',
        'libraryCatalog',
        'archive',
        'archiveLocation',
        'callNumber',
        'accessedAt',
        'extra',
        'arxivId',
        'citationCount',
        'referenceCount',
        'openAccessPdfUrl',
      ];

      for (const col of physicalColumns) {
        expect(CATALOG_COLUMN_METADATA_FIELDS.has(col)).toBe(true);
      }
    });

    it('should NEVER treat physical columns as extraFields', () => {
      const physicalColumnsThatWerePollutingExtra = [
        'year',
        'abstract',
        'itemType',
        'publicationDate',
        'seriesNumber',
        'citationCount',
        'referenceCount',
        'openAccessPdfUrl',
        'arxivId',
      ];

      for (const col of physicalColumnsThatWerePollutingExtra) {
        expect(TYPE_SPECIFIC_EXTRA_FIELDS.includes(col as any)).toBe(false);
      }
    });

    it('should correctly expose bidirectional field aliases', () => {
      expect(FIELD_ALIASES['abstractNote']).toBe('abstract');
      expect(FIELD_ALIASES['date']).toBe('publicationDate');
      expect(FIELD_ALIASES['journal']).toBe('publicationTitle');
      expect(FIELD_ALIASES['journalAbbreviation']).toBe('journalAbbr');
      expect(FIELD_ALIASES['archiveId']).toBe('arxivId');

      expect(REVERSE_FIELD_ALIASES['abstract']).toBe('abstractNote');
      expect(REVERSE_FIELD_ALIASES['publicationDate']).toBe('date');
      expect(REVERSE_FIELD_ALIASES['publicationTitle']).toBe('journal');
      expect(REVERSE_FIELD_ALIASES['journalAbbr']).toBe('journalAbbreviation');
      expect(REVERSE_FIELD_ALIASES['arxivId']).toBe('archiveId');
    });
  });

  describe('ItemsMapper.toDomain - Pure Plain-Text Extra Contract', () => {
    it('should preserve plain text extra unconditionally', () => {
      const plainText = 'arXiv:1406.2661 [stat.ML]\nPMID: 25013171\nMR: 3241234';
      const result: Record<string, any> = ItemsMapper.toDomain({
        id: 'test-1',
        title: 'Generative Adversarial Nets',
        extra: plainText,
      });

      expect(result.extra).toBe(plainText);
    });

    it('should restore legacy JSON string with _rawExtra to clean plain text', () => {
      const legacyJson = JSON.stringify({
        _rawExtra: 'arXiv:1406.2661 [stat.ML]',
        seriesNumber: '1',
      });
      const result: Record<string, any> = ItemsMapper.toDomain({
        id: 'test-2',
        title: 'GANs',
        extra: legacyJson,
      });

      expect(result.extra).toBe('arXiv:1406.2661 [stat.ML]');
    });

    it('should restore legacy JSON without _rawExtra into key: value lines instead of undefined', () => {
      const legacyJson = JSON.stringify({
        genre: 'Preprint',
        customTag: 'NeurIPS Spotlight',
      });
      const result: Record<string, any> = ItemsMapper.toDomain({
        id: 'test-3',
        title: 'GANs',
        extra: legacyJson,
      });

      expect(result.extra).toContain('genre: Preprint');
      expect(result.extra).toContain('customTag: NeurIPS Spotlight');
      expect(result.extra.startsWith('{')).toBe(false);
    });

    it('should automatically prepend arXiv:<id> [<category>] for preprints missing it in extra', () => {
      const result: Record<string, any> = ItemsMapper.toDomain({
        id: 'test-4',
        title: 'Deep Residual Learning for Image Recognition',
        itemType: 'preprint',
        arxivId: '1512.03385',
        extra: 'PMID: 99999',
        tags: [{ name: 'cs.CV' }],
      });

      expect(result.extra).toContain('arXiv:1512.03385 [cs.CV]');
      expect(result.extra).toContain('PMID: 99999');
      expect(result.archiveId).toBe('arXiv:1512.03385');
    });

    it('should sanitize category brackets out of arxivId/archiveId and format extra properly', () => {
      const result: Record<string, any> = ItemsMapper.toDomain({
        id: 'test-4b',
        title: 'Deep Residual Learning for Image Recognition',
        itemType: 'preprint',
        arxivId: '1512.03385v1[cs.CV]',
        tags: [{ name: 'cs.CV' }],
      });

      expect(result.arxivId).toBe('1512.03385v1');
      expect(result.archiveId).toBe('arXiv:1512.03385');
      expect(result.extra).toBe('arXiv:1512.03385 [cs.CV]');
    });

    it('should clean legacy callNumber containing arXiv ID and map to arxivId', () => {
      const result: Record<string, any> = ItemsMapper.toDomain({
        id: 'test-5',
        title: 'Attention Is All You Need',
        callNumber: 'arXiv:1706.03762',
      });

      expect(result.callNumber).toBeNull();
      expect(result.arxivId).toBe('1706.03762');
    });

    it('should cross-project rights and license bidirectionally', () => {
      const withRights: Record<string, any> = ItemsMapper.toDomain({
        id: 'test-6a',
        title: 'Paper A',
        rights: 'CC BY 4.0',
      });
      expect(withRights.rights).toBe('CC BY 4.0');
      expect(withRights.license).toBe('CC BY 4.0');

      const withLicense: Record<string, any> = ItemsMapper.toDomain({
        id: 'test-6b',
        title: 'Paper B',
        license: 'MIT',
      });
      expect(withLicense.license).toBe('MIT');
      expect(withLicense.rights).toBe('MIT');
    });

    it('should harmonize all field aliases', () => {
      const item: Record<string, any> = ItemsMapper.toDomain({
        id: 'test-7',
        title: 'Test Paper',
        abstract: 'Abstract content',
        publicationDate: '2024-05-01',
        publicationTitle: 'Nature AI',
        journalAbbr: 'Nat. AI',
        arxivId: '2405.00001',
      });

      expect(item.abstractNote).toBe('Abstract content');
      expect(item.date).toBe('2024-05-01');
      expect(item.journal).toBe('Nature AI');
      expect(item.journalAbbreviation).toBe('Nat. AI');
      expect(item.archiveId).toBe('2405.00001');
    });

    it('should harmonize uppercase and lowercase identifier aliases bidirectionally', () => {
      const item: Record<string, any> = ItemsMapper.toDomain({
        id: 'test-8',
        title: 'Identifier Test',
        doi: '10.1234/test',
        isbn: '978-1-23-456789-0',
        issn: '1234-5678',
        pmid: '123456',
        pmcid: 'PMC654321',
        arxivId: '2101.12345',
        citationCount: 42,
      });

      expect(item.doi).toBe('10.1234/test');
      expect(item.DOI).toBe('10.1234/test');
      expect(item.isbn).toBe('978-1-23-456789-0');
      expect(item.ISBN).toBe('978-1-23-456789-0');
      expect(item.issn).toBe('1234-5678');
      expect(item.ISSN).toBe('1234-5678');
      expect(item.pmid).toBe('123456');
      expect(item.PMID).toBe('123456');
      expect(item.pmcid).toBe('PMC654321');
      expect(item.PMCID).toBe('PMC654321');
      expect(item.arxivId).toBe('2101.12345');
      expect(item.archiveId).toBe('2101.12345');
      expect(item.archiveID).toBe('2101.12345');
      expect(item.citationCount).toBe(42);
    });

    it('should project from uppercase input aliases to lowercase DB properties', () => {
      const item: Record<string, any> = ItemsMapper.toDomain({
        id: 'test-9',
        title: 'Uppercase Ingestion Test',
        DOI: '10.5678/uppercase',
        ISBN: '978-9-87-654321-0',
        ISSN: '8765-4321',
        PMID: '654321',
        PMCID: 'PMC123456',
        archiveID: '2202.99999',
      });

      expect(item.doi).toBe('10.5678/uppercase');
      expect(item.DOI).toBe('10.5678/uppercase');
      expect(item.isbn).toBe('978-9-87-654321-0');
      expect(item.ISBN).toBe('978-9-87-654321-0');
      expect(item.issn).toBe('8765-4321');
      expect(item.ISSN).toBe('8765-4321');
      expect(item.pmid).toBe('654321');
      expect(item.PMID).toBe('654321');
      expect(item.pmcid).toBe('PMC123456');
      expect(item.PMCID).toBe('PMC123456');
      expect(item.arxivId).toBe('2202.99999');
      expect(item.archiveId).toBe('2202.99999');
      expect(item.archiveID).toBe('2202.99999');
    });
  });

  describe('CslJsonMapper.toCsl - CSL 1.0.2 Compliance', () => {
    it('should map extra to CSL note field', () => {
      const extraText = 'arXiv:1406.2661 [stat.ML]';
      const csl = CslJsonMapper.toCsl({
        id: 'gan-2014',
        title: 'Generative Adversarial Nets',
        year: 2014,
        extra: extraText,
      });

      expect(csl.note).toBe(extraText);
    });

    it('should map all standard bibliographic identifiers to CSL', () => {
      const csl = CslJsonMapper.toCsl({
        id: 'test-csl',
        title: 'Sample Paper',
        doi: '10.1000/182',
        isbn: '978-3-16-148410-0',
        issn: '0028-0836',
        pmid: '12345678',
        pmcid: 'PMC1234567',
        url: 'https://example.com/paper',
        archive: 'arXiv',
        archiveLocation: 'NYC',
        callNumber: 'QA76.9',
        language: 'en',
      });

      expect(csl.DOI).toBe('10.1000/182');
      expect(csl.ISBN).toBe('978-3-16-148410-0');
      expect(csl.ISSN).toBe('0028-0836');
      expect(csl.PMID).toBe('12345678');
      expect(csl.PMCID).toBe('PMC1234567');
      expect(csl.URL).toBe('https://example.com/paper');
      expect(csl.archive).toBe('arXiv');
      expect(csl.archive_location).toBe('NYC');
      expect(csl['call-number']).toBe('QA76.9');
      expect(csl.language).toBe('en');
    });
  });
});
