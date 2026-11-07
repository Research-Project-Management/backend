import {
  getAuthoritySourceWeight,
  coalesceMetadataValues,
  reconcileBibliographicRecord,
  isPreprintVenue,
  isPreprintDoi,
  upgradePreprintToPublished,
  synchronizeVenueBaseFields,
  buildBibliographicMutationPayload,
  harmonizeFields,
} from '@/modules/library/core/domain/bibliographic-reconciler.domain';
import {
  previewItemTypeConversion,
  buildTypeConversionUpdatePayload,
  getItemFieldValueWithTombstones,
} from '@/modules/library/catalog/domain/type-conversion.policy';
import {
  validateAndSanitizeSchemaItem,
  validateAndHarmonizeSchemaCreators,
  isSchemaValidItemType,
} from '@/modules/library/catalog/services/schema-validator.service';
import { IngestionSagaOrchestrator } from '@/modules/library/ingestion/services/ingestion-saga.orchestrator';
import type { ItemDetail } from '@/modules/library/core/types/bibliographic.types';

describe('BibliographicReconciler & TypeConversion Domain Suite', () => {
  describe('1. Authority Source Priority & Metadata Coalescing', () => {
    it('ranks authority sources according to canonical hierarchy', () => {
      expect(getAuthoritySourceWeight('user_override')).toBeGreaterThan(
        getAuthoritySourceWeight('crossref'),
      );
      expect(getAuthoritySourceWeight('crossref', 'doi')).toBeGreaterThan(
        getAuthoritySourceWeight('pubmed', 'doi'),
      );
      expect(getAuthoritySourceWeight('pubmed', 'pmid')).toBeGreaterThan(
        getAuthoritySourceWeight('arxiv', 'pmid'),
      );
      expect(getAuthoritySourceWeight('arxiv')).toBeGreaterThan(
        getAuthoritySourceWeight('openalex'),
      );
      expect(getAuthoritySourceWeight('openalex')).toBeGreaterThan(
        getAuthoritySourceWeight('local_pdf'),
      );
      expect(getAuthoritySourceWeight('local_pdf')).toBeGreaterThan(
        getAuthoritySourceWeight('filename'),
      );
    });

    it('demotes CrossRef journal-level subjects below paper-level keywords from Semantic Scholar / OpenAlex', () => {
      const s2Weight = getAuthoritySourceWeight('semanticscholar', 'keywords');
      const crossrefWeight = getAuthoritySourceWeight('crossref', 'keywords');
      expect(s2Weight).toBeGreaterThan(crossrefWeight);

      const winner = coalesceMetadataValues('keywords', [
        {
          path: 'keywords',
          value: ['General Medicine', 'Internal Medicine'],
          normalizedValue: ['General Medicine', 'Internal Medicine'],
          sourceProvider: 'crossref',
          confidence: 0.95,
          retrievedAt: new Date().toISOString(),
        },
        {
          path: 'keywords',
          value: ['Transformer', 'Attention Mechanism', 'NLP'],
          normalizedValue: ['Transformer', 'Attention Mechanism', 'NLP'],
          sourceProvider: 'semanticscholar',
          confidence: 0.9,
          retrievedAt: new Date().toISOString(),
        },
      ]);
      expect(winner.resolvedValue).toEqual([
        'Transformer',
        'Attention Mechanism',
        'NLP',
      ]);
    });

    it('reconciles multi-provider bibliographic candidates and prefers fuller author given names', () => {
      const decision = reconcileBibliographicRecord([
        {
          candidateId: 'cand-crossref',
          sourceKind: 'PROVIDER',
          sourceName: 'crossref',
          sourceProvider: 'crossref',
          confidenceScore: 0.95,
          retrievedAt: new Date().toISOString(),
          fields: {},
          normalizedMetadata: {
            title: 'Attention Is All You Need',
            doi: '10.5555/3295222.3295349',
            year: 2017,
            authors: ['A. Vaswani', 'N. Shazeer'],
            publicationTitle: 'Advances in Neural Information Processing Systems',
          },
        },
        {
          candidateId: 'cand-arxiv',
          sourceKind: 'PROVIDER',
          sourceName: 'arxiv',
          sourceProvider: 'arxiv',
          confidenceScore: 0.9,
          retrievedAt: new Date().toISOString(),
          fields: {},
          normalizedMetadata: {
            title: 'Attention Is All You Need',
            arxivId: '1706.03762',
            year: 2017,
            authors: ['Ashish Vaswani', 'Noam Shazeer'],
            abstract:
              'The dominant sequence transduction models are based on complex recurrent or convolutional neural networks in an encoder-decoder configuration.',
          },
        },
      ]);

      expect(decision.proposedItem.title).toBe('Attention Is All You Need');
      expect(decision.proposedItem.doi).toBe('10.5555/3295222.3295349');
      expect(decision.proposedItem.arxivId).toBe('1706.03762');
      expect(decision.proposedItem.authors).toEqual([
        'Ashish Vaswani',
        'Noam Shazeer',
      ]);
      expect(decision.proposedItem.abstract).toContain(
        'dominant sequence transduction',
      );
    });

    it('preserves user-override authority during existing-vs-incoming reconciliation', () => {
      const existing = {
        title: 'Custom Curated Title',
        publicationTitle: 'Nature',
        year: 2023,
      };
      const incoming = {
        title: 'Registry Title From CrossRef',
        publicationTitle: 'Nature Machine Intelligence',
        volume: '5',
        issue: '2',
        pages: '100-112',
      };

      const decision = reconcileBibliographicRecord(existing, incoming, {
        existingSourceProvider: 'useroverride',
        incomingSourceProvider: 'crossref',
      });

      expect(decision.proposedItem.title).toBe('Custom Curated Title');
      expect(decision.proposedItem.volume).toBe('5');
      expect(decision.proposedItem.pages).toBe('100-112');
    });
  });

  describe('2. Preprint-to-Journal Upgrade', () => {
    it('detects preprint venues and preprint DOIs accurately', () => {
      expect(isPreprintVenue('arXiv')).toBe(true);
      expect(isPreprintVenue('bioRxiv')).toBe(true);
      expect(isPreprintVenue('medRxiv')).toBe(true);
      expect(isPreprintVenue('IEEE Transactions on Pattern Analysis')).toBe(
        false,
      );

      expect(isPreprintDoi('10.48550/arXiv.1706.03762')).toBe(true);
      expect(isPreprintDoi('10.1101/2021.05.01.442233')).toBe(true);
      expect(isPreprintDoi('10.1038/s41586-021-03819-2')).toBe(false);
    });

    it('upgrades an arXiv preprint to a peer-reviewed conferencePaper/journalArticle while preserving arXiv ID in extra', () => {
      const existingPreprint = {
        itemType: 'preprint',
        title: 'Deep Residual Learning for Image Recognition',
        publicationTitle: 'arXiv',
        venue: 'arXiv',
        arxivId: '1512.03385',
        doi: '10.48550/arXiv.1512.03385',
        year: 2015,
      };

      const publishedIncoming = {
        itemType: 'conferencePaper',
        title: 'Deep Residual Learning for Image Recognition',
        proceedingsTitle:
          '2016 IEEE Conference on Computer Vision and Pattern Recognition (CVPR)',
        doi: '10.1109/CVPR.2016.90',
        year: 2016,
        pages: '770-778',
        publisher: 'IEEE',
      };

      const upgrade = upgradePreprintToPublished(
        existingPreprint,
        publishedIncoming,
      );

      expect(upgrade.upgraded).toBe(true);
      expect(upgrade.targetItemType).toBe('conferencePaper');
      expect(upgrade.record.itemType).toBe('conferencePaper');
      expect(upgrade.record.doi).toBe('10.1109/CVPR.2016.90');
      expect(upgrade.record.proceedingsTitle).toBe(
        '2016 IEEE Conference on Computer Vision and Pattern Recognition (CVPR)',
      );
      expect(upgrade.record.pages).toBe('770-778');
      expect(upgrade.record.arxivId).toBe('1512.03385');
      expect(upgrade.record.extra).toContain('arXiv: 1512.03385');
    });
  });

  describe('3. Base Field Venue Mapping & Prisma Mutation Payload', () => {
    it('maps conferencePaper venue to proceedingsTitle and prunes foreign container keys', () => {
      const record: Record<string, unknown> = {
        publicationTitle: 'NeurIPS 2024',
        bookTitle: 'Wrong Book Container',
        extraFields: {
          publicationTitle: 'NeurIPS 2024',
          bookTitle: 'Wrong Book Container',
        },
      };
      const synced = synchronizeVenueBaseFields(record, 'conferencePaper', {
        pruneForeignContainerKeys: true,
      });

      expect(synced.proceedingsTitle).toBe('NeurIPS 2024');
      expect(synced.venue).toBe('NeurIPS 2024');
      expect(synced.bookTitle).toBeUndefined();
      const extraFields = synced.extraFields as Record<string, unknown>;
      expect(extraFields.proceedingsTitle).toBe('NeurIPS 2024');
      expect(extraFields.bookTitle).toBeUndefined();
    });

    it('maps journalArticle venue to publicationTitle and journal', () => {
      const record: Record<string, unknown> = {
        proceedingsTitle: 'Journal of Machine Learning Research',
      };
      const synced = synchronizeVenueBaseFields(record, 'journalArticle', {
        pruneForeignContainerKeys: true,
      });

      expect(synced.publicationTitle).toBe(
        'Journal of Machine Learning Research',
      );
      expect(synced.journal).toBe('Journal of Machine Learning Research');
      expect(synced.venue).toBe('Journal of Machine Learning Research');
      expect(synced.proceedingsTitle).toBeUndefined();
    });

    it('maps bookSection venue to bookTitle in buildBibliographicMutationPayload', () => {
      const payload = buildBibliographicMutationPayload(
        {
          itemType: 'bookSection',
          title: 'Chapter 3: Deep Module Architecture',
          publicationTitle: 'A Philosophy of Software Design',
          year: 2018,
        },
        { pruneForeignContainerKeys: true },
      );

      expect(payload.mappedPublicationField).toBe('bookTitle');
      expect(payload.primaryVenue).toBe('A Philosophy of Software Design');
      expect(payload.harmonized.bookTitle).toBe(
        'A Philosophy of Software Design',
      );
      expect(payload.harmonized.venue).toBe('A Philosophy of Software Design');
    });

    it('exposes harmonizeFields alias that remaps base fields across types', () => {
      const harmonized = harmonizeFields(
        {
          title: 'Test Legal Case',
          publicationTitle: 'Supreme Court Reporter',
          date: '2024-06-01',
        },
        'case',
      );

      expect(harmonized.caseName).toBe('Test Legal Case');
      expect(harmonized.reporter).toBe('Supreme Court Reporter');
      expect(harmonized.dateDecided).toBe('2024-06-01');
    });
  });

  describe('4. Item Type Conversion with Unmapped Field Tombstones & Round-Trip Restoration', () => {
    it('preserves unmapped fields in __unmapped_* tombstones and restores them on round-trip conversion', () => {
      const originalJournalArticle = {
        id: 'item-1',
        itemType: 'journalArticle',
        title: 'Quantum Error Correction in Surface Codes',
        publicationTitle: 'Physical Review X',
        volume: '12',
        issue: '4',
        pages: '041021',
        doi: '10.1103/PhysRevX.12.041021',
        issn: '2160-3308',
        extraFields: {
          publicationTitle: 'Physical Review X',
          volume: '12',
          issue: '4',
          pages: '041021',
          doi: '10.1103/PhysRevX.12.041021',
          issn: '2160-3308',
        },
        creators: [],
      } as unknown as ItemDetail;

      // Step 1: Convert journalArticle -> book
      const toBookPreview = previewItemTypeConversion(
        originalJournalArticle as unknown as Record<string, unknown>,
        'book',
      );
      const toBookPayload = buildTypeConversionUpdatePayload(
        'book',
        originalJournalArticle,
        toBookPreview,
      );

      expect(toBookPayload.itemType).toBe('book');
      expect(toBookPayload.issue).toBeNull();
      expect(toBookPayload.pages).toBeNull();
      const toBookExtra = toBookPayload.extraFields as Record<string, unknown>;
      expect(toBookExtra.__unmapped_journalArticle_issue).toBe('4');
      expect(toBookExtra.__unmapped_journalArticle_pages).toBe('041021');

      // Step 2: Convert book -> journalArticle (round-trip)
      const intermediateBookItem = {
        ...originalJournalArticle,
        ...toBookPayload,
        extraFields: toBookExtra,
      } as unknown as ItemDetail;

      const previewBackToJournal = previewItemTypeConversion(
        intermediateBookItem as unknown as Record<string, unknown>,
        'journalArticle',
      );
      expect(previewBackToJournal.preservedFields).toEqual(
        expect.arrayContaining(['issue', 'pages']),
      );

      const roundTripPayload = buildTypeConversionUpdatePayload(
        'journalArticle',
        intermediateBookItem,
        previewBackToJournal,
      );

      expect(roundTripPayload.itemType).toBe('journalArticle');
      expect(roundTripPayload.issue).toBe('4');
      expect(roundTripPayload.pages).toBe('041021');
      const roundTripExtra = roundTripPayload.extraFields as Record<
        string,
        unknown
      >;
      expect(roundTripExtra.__unmapped_journalArticle_issue).toBeNull();
      expect(roundTripExtra.__unmapped_journalArticle_pages).toBeNull();
    });

    it('reads active fields before tombstoned fields in getItemFieldValueWithTombstones', () => {
      const item = {
        itemType: 'book',
        title: 'Active Title',
        extraFields: {
          __unmapped_journalArticle_issue: '7',
        },
      };
      expect(getItemFieldValueWithTombstones(item, 'title')).toBe(
        'Active Title',
      );
      expect(getItemFieldValueWithTombstones(item, 'issue')).toBe('7');
    });

    it('validates and sanitizes schema items purely without DI or Redis', () => {
      expect(isSchemaValidItemType('journalArticle')).toBe(true);
      expect(isSchemaValidItemType('nonExistentType')).toBe(false);

      const creatorsResult = validateAndHarmonizeSchemaCreators(
        'journalArticle',
        [{ firstName: 'Ada', lastName: 'Lovelace', creatorType: 'inventor' }],
      );
      expect(creatorsResult.creators[0].creatorType).toBe('author');
      expect(creatorsResult.changes.length).toBeGreaterThan(0);

      const sanitized = validateAndSanitizeSchemaItem('conferencePaper', {
        title: 'Distributed Consensus at Scale',
        publicationTitle: 'OSDI 2024',
        unsupportedCustomField: 'demoted-val',
      });
      expect(sanitized.sanitizedItem.publicationTitle).toBe('OSDI 2024');
      expect(sanitized.demotedToExtra.unsupportedCustomField).toBe(
        'demoted-val',
      );
    });
  });

  describe('5. IngestionSagaOrchestrator Encapsulated Run Tracking', () => {
    it('tracks and clears run transitions via encapsulated methods', () => {
      const runId = 'test-saga-run-123';
      IngestionSagaOrchestrator.clearRunTracking(runId);
      expect(IngestionSagaOrchestrator.hasTransitioned(runId)).toBe(false);

      IngestionSagaOrchestrator.markRunTransitioned(runId);
      expect(IngestionSagaOrchestrator.hasTransitioned(runId)).toBe(true);

      IngestionSagaOrchestrator.clearRunTracking(runId);
      expect(IngestionSagaOrchestrator.hasTransitioned(runId)).toBe(false);
    });
  });
});
