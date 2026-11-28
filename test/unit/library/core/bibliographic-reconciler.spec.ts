import {
  MetadataCoalescePolicy,
  getAuthoritySourceWeight,
  coalesceMetadataValues,
  reconcileBibliographicRecord,
  evaluateCitationTrap,
  verifyTitleLookupCorroboration,
  verifyCandidateMatch,
  isSameCanonicalIdentifier,
  isPreprintVenue,
  isPreprintDoi,
  upgradePreprintToPublished,
  synchronizeVenueBaseFields,
  buildBibliographicMutationPayload,
  harmonizeFields,
} from '@/modules/library/core/domain/reconciler.domain';
import {
  harmonizeBibliographicFields,
  inferItemTypeFromPdfSignals,
  ItemDetail,
} from '@/modules/library/core';
import {
  previewItemTypeConversion,
  buildTypeConversionUpdatePayload,
  getItemFieldValueWithTombstones,
} from '@/modules/library/catalog/domain/type-conversion.policy';
import {
  validateAndSanitizeSchemaItem,
  validateAndHarmonizeSchemaCreators,
  isSchemaValidItemType,
} from '@/modules/library/catalog/domain/item-schema.policy';
import type { ItemMetadata } from '@/modules/library/ingestion/types/metadata.types';

function makeCandidate(
  sourceProvider: string,
  confidenceScore: number,
  normalizedMetadata: ItemMetadata,
  sourceKind:
    | 'IDENTIFIER'
    | 'RECORD'
    | 'URL'
    | 'FILE'
    | 'PROVIDER'
    | 'CONNECTOR' = 'PROVIDER',
) {
  return {
    candidateId: `cand-${sourceProvider.toLowerCase()}`,
    sourceKind,
    sourceName: sourceProvider,
    sourceProvider,
    retrievedAt: '2025-02-01T00:00:00.000Z',
    fields: {},
    normalizedMetadata,
    confidenceScore,
  };
}

describe('Bibliographic Reconciler, Preprint Upgrade, Type Conversion & Item-Type Inference', () => {
  describe('Authority Hierarchy & Multi-Source Coalescing', () => {
    it('ranks authority sources canonically and demotes CrossRef journal subjects below paper-level keywords', () => {
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

      const winner = coalesceMetadataValues('keywords', [
        {
          path: 'keywords',
          value: ['General Medicine', 'Internal Medicine'],
          normalizedValue: ['General Medicine', 'Internal Medicine'],
          sourceProvider: 'crossref',
          confidence: 0.95,
          retrievedAt: '2025-02-01T00:00:00.000Z',
        },
        {
          path: 'keywords',
          value: ['Transformer', 'Attention Mechanism', 'NLP'],
          normalizedValue: ['Transformer', 'Attention Mechanism', 'NLP'],
          sourceProvider: 'semanticscholar',
          confidence: 0.9,
          retrievedAt: '2025-02-01T00:00:00.000Z',
        },
      ]);
      expect(winner.resolvedValue).toEqual([
        'Transformer',
        'Attention Mechanism',
        'NLP',
      ]);
    });

    it('upgrades initialed authors to full given names without truncation and preserves distinct author/editor roles', () => {
      const fullEightAuthors = [
        'Ashish Vaswani',
        'Noam Shazeer',
        'Niki Parmar',
        'Jakob Uszkoreit',
        'Llion Jones',
        'Aidan N. Gomez',
        'Lukasz Kaiser',
        'Illia Polosukhin',
      ];
      const coalesced = MetadataCoalescePolicy.coalesceCandidates([
        makeCandidate(
          'LocalPDFExtraction',
          0.72,
          {
            title: 'Attention Is All You Need',
            authors: ['A. Vaswani', 'N. Shazeer', 'N. Parmar'],
            year: 2017,
          },
          'FILE',
        ),
        makeCandidate('CrossRef', 0.96, {
          title: 'Attention Is All You Need',
          authors: fullEightAuthors,
          creators: fullEightAuthors.map((fullName, orderIndex) => {
            const parts = fullName.split(' ');
            const lastName = parts.pop() || fullName;
            return {
              creatorType: 'author',
              firstName: parts.join(' '),
              lastName,
              fullName,
              orderIndex,
            };
          }),
          year: 2017,
          doi: '10.5555/3295222.3295349',
        }),
      ]);
      expect(coalesced.proposedItem.authors).toEqual(fullEightAuthors);
      expect(coalesced.proposedItem.creators).toHaveLength(8);

      const chapterCoalesced = MetadataCoalescePolicy.coalesceCandidates([
        makeCandidate('CrossRef', 0.95, {
          itemType: 'bookSection',
          title: 'Neural Symbolic Reasoning in Knowledge Graphs',
          authors: ['Elena Rostova', 'Marcus Vance'],
          bookTitle: 'Handbook of Neuro-Symbolic AI',
          year: 2024,
        }),
        makeCandidate(
          'BibTeX',
          0.88,
          {
            itemType: 'bookSection',
            title: 'Neural Symbolic Reasoning in Knowledge Graphs',
            authors: ['E. Rostova', 'M. Vance'],
            editors: ['Alan Turing', 'Claude Shannon'],
            bookTitle: 'Handbook of Neuro-Symbolic AI',
            year: 2024,
          },
          'RECORD',
        ),
      ]);
      expect(chapterCoalesced.proposedItem.authors).toEqual([
        'Elena Rostova',
        'Marcus Vance',
      ]);
      expect(chapterCoalesced.proposedItem.editors).toEqual([
        'Alan Turing',
        'Claude Shannon',
      ]);
    });

    it('preserves user-override authority, synchronizes year/date/publicationDate, and isolates all 5 identifiers', () => {
      const userOverrideDecision = reconcileBibliographicRecord(
        { title: 'Custom Curated Title', publicationTitle: 'Nature', year: 2023 },
        {
          title: 'Registry Title From CrossRef',
          volume: '5',
          pages: '100-112',
        },
        {
          existingSourceProvider: 'useroverride',
          incomingSourceProvider: 'crossref',
        },
      );
      expect(userOverrideDecision.proposedItem.title).toBe(
        'Custom Curated Title',
      );
      expect(userOverrideDecision.proposedItem.volume).toBe('5');

      const dateSync = MetadataCoalescePolicy.coalesceCandidates([
        makeCandidate(
          'LocalPDFExtraction',
          0.65,
          {
            title:
              'Deterministic Consensus in Byzantine Fault-Tolerant Ledgers',
            authors: ['Hao Chen'],
            year: 2026,
            publicationDate: '2026-01-10',
          },
          'FILE',
        ),
        makeCandidate('CrossRef', 0.96, {
          title: 'Deterministic Consensus in Byzantine Fault-Tolerant Ledgers',
          authors: ['Hao Chen'],
          year: 2023,
          publicationDate: '2023-05-14',
          doi: '10.1145/3588888.3588999',
          journal: 'Journal of the ACM',
        }),
      ]);
      const syncedItem = dateSync.proposedItem as Record<string, unknown>;
      expect(syncedItem.year).toBe(2023);
      expect(syncedItem.publicationDate).toBe('2023-05-14');
      expect(syncedItem.date).toBe('2023-05-14');

      const multiIds = MetadataCoalescePolicy.coalesceCandidates([
        makeCandidate('PubMed', 0.96, {
          itemType: 'journalArticle',
          title: 'CRISPR-Cas9 Base Editing in Human Hematopoietic Stem Cells',
          authors: ['Alexis Komor', 'David Liu'],
          pmid: '34567890',
          pmcid: 'PMC8765432',
          doi: '10.1056/nejmoa2109876',
          issn: '0028-4793',
          year: 2022,
        }),
        makeCandidate('arXiv', 0.85, {
          itemType: 'preprint',
          title: 'CRISPR-Cas9 Base Editing in Human Hematopoietic Stem Cells',
          authors: ['Alexis Komor', 'David Liu'],
          arxivId: '2111.05432',
          year: 2021,
        }),
      ]);
      expect(multiIds.proposedItem).toMatchObject({
        doi: '10.1056/nejmoa2109876',
        pmid: '34567890',
        pmcid: 'PMC8765432',
        issn: '0028-4793',
        arxivId: '2111.05432',
      });
      expect(multiIds.proposedItem.isbn).toBeUndefined();
      expect(
        isSameCanonicalIdentifier(
          '10.48550/arXiv.2111.05432v2',
          'arXiv:2111.05432',
        ),
      ).toBe(true);
      expect(
        isSameCanonicalIdentifier(
          '10.1056/NEJMoa2109876',
          '10.48550/arXiv.2111.05432',
        ),
      ).toBe(false);
    });
  });

  describe('Citation-Poisoning Guard & Preprint-to-Published Upgrade', () => {
    it('blocks cited baseline DOIs from poisoning unrelated local PDFs', () => {
      const localPdfMeta = {
        title:
          'Self-Supervised Volumetric Transformer for 3D Brain MRI Segmentation',
        authors: ['Minh Nguyen', 'Sarah Jenkins'],
        year: 2024,
        doi: '10.1109/cvpr.2016.90',
      };
      const citedResNetMeta = {
        title: 'Deep Residual Learning for Image Recognition',
        authors: ['Kaiming He', 'Xiangyu Zhang', 'Shaoqing Ren', 'Jian Sun'],
        year: 2016,
        doi: '10.1109/cvpr.2016.90',
      };

      const trap = evaluateCitationTrap(localPdfMeta, citedResNetMeta, false);
      expect(trap.isTrap).toBe(true);
      expect(trap.rejectedDoi).toBe('10.1109/cvpr.2016.90');
      expect(
        verifyCandidateMatch(
          makeCandidate('LocalPDFExtraction', 0.75, localPdfMeta, 'FILE'),
          makeCandidate('CrossRef', 0.95, citedResNetMeta, 'PROVIDER'),
        ),
      ).toBe(false);
      expect(
        verifyTitleLookupCorroboration(
          localPdfMeta.title,
          localPdfMeta,
          citedResNetMeta,
        ).accepted,
      ).toBe(false);
    });

    it('upgrades arXiv preprints to published journal/conference articles while keeping pure arXiv preprints as preprint', () => {
      expect(isPreprintVenue('arXiv')).toBe(true);
      expect(isPreprintVenue('bioRxiv')).toBe(true);
      expect(isPreprintDoi('10.48550/arXiv.1706.03762')).toBe(true);
      expect(isPreprintDoi('10.1038/s41586-021-03819-2')).toBe(false);

      const upgraded = upgradePreprintToPublished(
        {
          itemType: 'preprint',
          title: 'Deep Residual Learning for Image Recognition',
          publicationTitle: 'arXiv',
          arxivId: '1512.03385',
          doi: '10.48550/arXiv.1512.03385',
          year: 2015,
        },
        {
          itemType: 'conferencePaper',
          title: 'Deep Residual Learning for Image Recognition',
          proceedingsTitle: 'CVPR 2016',
          doi: '10.1109/CVPR.2016.90',
          year: 2016,
          pages: '770-778',
        },
      );
      expect(upgraded.upgraded).toBe(true);
      expect(upgraded.record.itemType).toBe('conferencePaper');
      expect(upgraded.record.doi).toBe('10.1109/CVPR.2016.90');
      expect(upgraded.record.extra).toContain('arXiv: 1512.03385');

      const purePreprint = MetadataCoalescePolicy.coalesceCandidates([
        makeCandidate('CrossRef', 0.95, {
          itemType: 'journalArticle',
          title: 'Scaling Laws for Autoregressive Multimodal Foundation Models',
          authors: ['Linh Tran', 'David Park'],
          doi: '10.48550/arXiv.2402.09876',
          journal: 'arXiv',
          publicationTitle: 'arXiv (Cornell University)',
          publisher: 'arXiv',
          year: 2024,
        }),
        makeCandidate('arXiv', 0.95, {
          itemType: 'preprint',
          title: 'Scaling Laws for Autoregressive Multimodal Foundation Models',
          authors: ['Linh Tran', 'David Park'],
          arxivId: '2402.09876',
          repository: 'arXiv',
          year: 2024,
        }),
      ]);
      expect(purePreprint.proposedItem.itemType).toBe('preprint');
      expect(purePreprint.proposedItem.journal).toBeUndefined();
      expect(purePreprint.proposedItem.repository).toBe('arXiv');
    });
  });

  describe('Venue Harmonization, Type Conversion Tombstones & Schema Policy', () => {
    it('synchronizes container fields per itemType and prunes foreign container keys', () => {
      const conf = synchronizeVenueBaseFields(
        {
          publicationTitle: 'NeurIPS 2024',
          bookTitle: 'Wrong Book Container',
          extraFields: { bookTitle: 'Wrong Book Container' },
        } as Record<string, unknown>,
        'conferencePaper',
        { pruneForeignContainerKeys: true },
      );
      expect(conf.proceedingsTitle).toBe('NeurIPS 2024');
      expect(conf.bookTitle).toBeUndefined();

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
      expect(payload.harmonized.bookTitle).toBe(
        'A Philosophy of Software Design',
      );

      expect(
        harmonizeFields(
          {
            title: 'Test Legal Case',
            publicationTitle: 'Supreme Court Reporter',
            date: '2024-06-01',
          },
          'case',
        ),
      ).toMatchObject({
        caseName: 'Test Legal Case',
        reporter: 'Supreme Court Reporter',
        dateDecided: '2024-06-01',
      });

      expect(
        harmonizeBibliographicFields(
          {
            itemType: 'conferencePaper',
            title: 'Grouped Query Attention',
            publicationTitle: 'EMNLP 2023',
            place: 'Singapore',
          },
          { itemType: 'conferencePaper', syncExtraFields: true },
        ),
      ).toMatchObject({
        proceedingsTitle: 'EMNLP 2023',
        eventPlace: 'Singapore',
      });
    });

    it('preserves unmapped fields in __unmapped_* tombstones and restores them on round-trip conversion', () => {
      const original = {
        id: 'item-1',
        itemType: 'journalArticle',
        title: 'Quantum Error Correction in Surface Codes',
        publicationTitle: 'Physical Review X',
        volume: '12',
        issue: '4',
        pages: '041021',
        extraFields: { issue: '4', pages: '041021' },
        creators: [],
      } as unknown as ItemDetail;

      const toBookPreview = previewItemTypeConversion(original, 'book');
      const toBookPayload = buildTypeConversionUpdatePayload(
        'book',
        original,
        toBookPreview,
      );
      const bookExtra = toBookPayload.extraFields as Record<string, unknown>;
      expect(bookExtra.__unmapped_journalArticle_issue).toBe('4');
      expect(
        getItemFieldValueWithTombstones(
          { itemType: 'book', extraFields: bookExtra },
          'issue',
        ),
      ).toBe('4');

      const intermediate = {
        ...original,
        ...toBookPayload,
        extraFields: bookExtra,
      } as unknown as ItemDetail;
      const backPreview = previewItemTypeConversion(
        intermediate,
        'journalArticle',
      );
      const roundTrip = buildTypeConversionUpdatePayload(
        'journalArticle',
        intermediate,
        backPreview,
      );
      expect(roundTrip.issue).toBe('4');
      expect(roundTrip.pages).toBe('041021');
    });

    it('validates schema items and harmonizes creator roles purely', () => {
      expect(isSchemaValidItemType('journalArticle')).toBe(true);
      expect(isSchemaValidItemType('nonExistentType')).toBe(false);

      const creators = validateAndHarmonizeSchemaCreators('journalArticle', [
        { firstName: 'Ada', lastName: 'Lovelace', creatorType: 'inventor' },
      ]);
      expect(creators.creators[0].creatorType).toBe('author');

      const sanitized = validateAndSanitizeSchemaItem('conferencePaper', {
        title: 'Distributed Consensus at Scale',
        publicationTitle: 'OSDI 2024',
        unsupportedCustomField: 'demoted-val',
      });
      expect(sanitized.demotedToExtra.unsupportedCustomField).toBe(
        'demoted-val',
      );
    });
  });

  describe('inferItemTypeFromPdfSignals Heuristic', () => {
    it('classifies book, bookSection, conferencePaper, thesis, report, preprint, patent, and dataset while returning undefined for generic articles', () => {
      expect(
        inferItemTypeFromPdfSignals({ isbn: '9780262035613' })?.itemType,
      ).toBe('book');
      expect(
        inferItemTypeFromPdfSignals({
          isbn: '9780262035613',
          bookTitle: 'Advances in Machine Learning',
        })?.itemType,
      ).toBe('bookSection');
      expect(
        inferItemTypeFromPdfSignals({
          title: 'Attention Is All You Need',
          conferenceName: 'NeurIPS 2017',
        })?.itemType,
      ).toBe('conferencePaper');
      expect(
        inferItemTypeFromPdfSignals({
          title: 'Scalable Distributed Systems',
          notes: [
            {
              content:
                'Submitted in partial fulfilment for the degree of Doctor of Philosophy',
            },
          ],
        })?.itemType,
      ).toBe('thesis');
      expect(
        inferItemTypeFromPdfSignals({
          title: 'Scalable Systems',
          filename: 'john_doe_phd_thesis_2023.pdf',
        })?.itemType,
      ).toBe('thesis');
      expect(
        inferItemTypeFromPdfSignals({
          title: 'Cryptographic Standards',
          notes: ['NIST Special Publication 800-38'],
        })?.itemType,
      ).toBe('report');
      expect(
        inferItemTypeFromPdfSignals({
          title: 'Scaling Laws for Neural Language Models',
          notes: ['Under review at ICML 2025'],
        })?.itemType,
      ).toBe('preprint');
      expect(
        inferItemTypeFromPdfSignals({
          title: 'Generative Models',
          filename: 'arxiv_2310.06825v2.pdf',
        })?.itemType,
      ).toBe('preprint');
      expect(
        inferItemTypeFromPdfSignals({
          title:
            'Patent Application: Method and System for Training Neural Networks',
        })?.itemType,
      ).toBe('patent');
      expect(
        inferItemTypeFromPdfSignals({
          title: 'ImageNet: A Large-Scale Dataset for Visual Recognition',
        })?.itemType,
      ).toBe('dataset');

      expect(inferItemTypeFromPdfSignals({})).toBeUndefined();
      expect(
        inferItemTypeFromPdfSignals({
          title: 'A Novel Approach to Graph Neural Networks',
          journal: 'Nature Communications',
        }),
      ).toBeUndefined();
    });
  });
});
