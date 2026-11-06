import { Logger } from '@nestjs/common';
import {
  MetadataCoalescePolicy,
  evaluateCitationTrap,
  verifyTitleLookupCorroboration,
  verifyCandidateMatch,
  isSameCanonicalIdentifier,
} from '../../../src/modules/library/core/domain/metadata-coalesce.policy';
import { MetadataResolverService } from '../../../src/modules/library/ingestion/services/metadata-resolver.service';
import { BibtexParser } from '../../../src/modules/library/ingestion/parsers/bibtex.parser';
import { RisParser } from '../../../src/modules/library/ingestion/parsers/ris.parser';
import { XmlLegacyFormatsParser } from '../../../src/modules/library/ingestion/parsers/xml-legacy-formats.parser';
import {
  buildExtractedMetadataSyncPlan,
  sanitizeExtractedItemUpdateAgainstFreshState,
} from '../../../src/modules/library/extraction/domain/extraction-metadata-merge.policy';
import {
  buildEnrichmentPatch,
  buildReResolvePatch,
} from '../../../src/modules/library/ingestion/domain/enrichment-patch.mapper';
import type { ICatalogFacade, ItemDetail } from '../../../src/modules/library/core';
import type {
  ItemMetadata,
  MetadataPort,
} from '../../../src/modules/library/ingestion/types/metadata.types';

function makeCandidate(
  sourceProvider: string,
  confidenceScore: number,
  normalizedMetadata: ItemMetadata,
  sourceKind: 'IDENTIFIER' | 'RECORD' | 'URL' | 'FILE' | 'PROVIDER' | 'CONNECTOR' = 'PROVIDER',
) {
  return {
    candidateId: `cand-${sourceProvider.toLowerCase()}-${Math.random().toString(36).slice(2, 7)}`,
    sourceKind,
    sourceName: sourceProvider,
    sourceProvider,
    retrievedAt: '2025-02-01T00:00:00.000Z',
    fields: {},
    normalizedMetadata,
    confidenceScore,
  };
}

describe('Multi-Source Metadata Extraction & Cross-Source Coalescing Accuracy Audit', () => {
  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  // =========================================================================
  // 1. AUTHOR COUNT & ROLE PRESERVATION ACROSS SOURCES
  // =========================================================================
  describe('1. Author Count & Role Preservation (Zero Truncation / Zero Role Confusion)', () => {
    it('upgrades 3 initialed PDF/arXiv authors to all 8 full-given-name CrossRef/PubMed authors without dropping or duplicating', () => {
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
            const firstName = parts.join(' ');
            return {
              creatorType: 'author',
              firstName,
              lastName,
              fullName,
              orderIndex,
            };
          }),
          year: 2017,
          doi: '10.5555/3295222.3295349',
        }),
      ]);

      expect(coalesced.proposedItem.authors).toHaveLength(8);
      expect(coalesced.proposedItem.authors).toEqual(fullEightAuthors);
      expect(coalesced.proposedItem.creators).toHaveLength(8);
      expect(
        coalesced.proposedItem.creators?.every(
          (c) => c.creatorType === 'author' && !/^[A-Z]\.$/.test(c.firstName || ''),
        ),
      ).toBe(true);
    });

    it('preserves exact author and editor roles when coalescing an edited book chapter across BibTeX and CrossRef', () => {
      const coalesced = MetadataCoalescePolicy.coalesceCandidates([
        makeCandidate('CrossRef', 0.95, {
          itemType: 'bookSection',
          title: 'Neural Symbolic Reasoning in Knowledge Graphs',
          authors: ['Elena Rostova', 'Marcus Vance', 'Tariq Al-Mansoor'],
          bookTitle: 'Handbook of Neuro-Symbolic AI',
          year: 2024,
          doi: '10.1007/978-3-031-12345-6_8',
        }),
        makeCandidate(
          'BibTeX',
          0.88,
          {
            itemType: 'bookSection',
            title: 'Neural Symbolic Reasoning in Knowledge Graphs',
            authors: ['E. Rostova', 'M. Vance', 'T. Al-Mansoor'],
            editors: ['Alan Turing', 'Claude Shannon'],
            bookTitle: 'Handbook of Neuro-Symbolic AI',
            publisher: 'Springer Nature',
            pages: '215-248',
            year: 2024,
          },
          'RECORD',
        ),
      ]);

      expect(coalesced.proposedItem.authors).toEqual([
        'Elena Rostova',
        'Marcus Vance',
        'Tariq Al-Mansoor',
      ]);
      expect(coalesced.proposedItem.editors).toEqual(['Alan Turing', 'Claude Shannon']);

      const creators = coalesced.proposedItem.creators || [];
      const authorCreators = creators.filter((c) => c.creatorType === 'author');
      const editorCreators = creators.filter((c) => c.creatorType === 'editor');
      expect(authorCreators).toHaveLength(3);
      expect(editorCreators).toHaveLength(2);
      expect(editorCreators.map((c) => c.lastName)).toEqual(['Turing', 'Shannon']);
    });
  });

  // =========================================================================
  // 2. WRONG-PAPER / CITATION-POISONING GUARD
  // =========================================================================
  describe('2. Wrong-Paper / Citation-Poisoning Guard (Zero Baseline DOI Hijacking)', () => {
    it('evaluates citation trap and blocks a cited 2016 ResNet DOI from poisoning a 2024 Medical Vision PDF', () => {
      const localPdfMeta = {
        title: 'Self-Supervised Volumetric Transformer for 3D Brain MRI Segmentation',
        authors: ['Minh Nguyen', 'Sarah Jenkins'],
        year: 2024,
        doi: '10.1109/cvpr.2016.90',
      };
      const resolvedCitedBaselineMeta = {
        title: 'Deep Residual Learning for Image Recognition',
        authors: ['Kaiming He', 'Xiangyu Zhang', 'Shaoqing Ren', 'Jian Sun'],
        year: 2016,
        doi: '10.1109/cvpr.2016.90',
      };

      const trapCheck = evaluateCitationTrap(localPdfMeta, resolvedCitedBaselineMeta, false);
      expect(trapCheck.isTrap).toBe(true);
      expect(trapCheck.similarity).toBeLessThan(0.25);
      expect(trapCheck.rejectedDoi).toBe('10.1109/cvpr.2016.90');

      const candidateMatch = verifyCandidateMatch(
        makeCandidate('LocalPDFExtraction', 0.75, localPdfMeta, 'FILE'),
        makeCandidate('CrossRef', 0.95, resolvedCitedBaselineMeta, 'PROVIDER'),
      );
      expect(candidateMatch).toBe(false);

      const titleLookupCorroboration = verifyTitleLookupCorroboration(
        localPdfMeta.title,
        localPdfMeta,
        resolvedCitedBaselineMeta,
      );
      expect(titleLookupCorroboration.accepted).toBe(false);
    });

    it('rejects a cited baseline DOI in MetadataResolverService.reconcileExtractedCandidate and records rejectedCitedDoi', async () => {
      const existingItem: Record<string, unknown> = {
        id: 'item-mri-2024',
        title: 'Self-Supervised Volumetric Transformer for 3D Brain MRI Segmentation',
        itemType: 'journalArticle',
        year: 2024,
        doi: '10.1109/cvpr.2016.90',
        version: 1,
        creators: [
          { creatorType: 'author', firstName: 'Minh', lastName: 'Nguyen', fullName: 'Minh Nguyen' },
          {
            creatorType: 'author',
            firstName: 'Sarah',
            lastName: 'Jenkins',
            fullName: 'Sarah Jenkins',
          },
        ],
        extraFields: {},
      };

      const updateItemMock = jest.fn().mockImplementation(
        async (_u: string, _id: string, patch: Record<string, unknown>) =>
          ({
            ...existingItem,
            ...patch,
          }) as unknown as ItemDetail,
      );

      const mockCatalog: Partial<ICatalogFacade> = {
        getItem: jest.fn().mockResolvedValue(existingItem as unknown as ItemDetail),
        updateItem: updateItemMock,
      };
      const mockMetadataPort: Partial<MetadataPort> = {
        resolve: jest.fn().mockResolvedValue({
          metadata: {
            title: 'Deep Residual Learning for Image Recognition',
            authors: ['Kaiming He', 'Xiangyu Zhang', 'Shaoqing Ren', 'Jian Sun'],
            year: 2016,
            doi: '10.1109/cvpr.2016.90',
            journal: '2016 IEEE Conference on Computer Vision and Pattern Recognition (CVPR)',
          },
          provenance: {},
        }),
      };

      const resolver = new MetadataResolverService(
        mockCatalog as ICatalogFacade,
        mockMetadataPort as MetadataPort,
      );

      const res = await resolver.reconcileExtractedCandidate({
        userId: 'user-1',
        itemId: 'item-mri-2024',
        extractedMetadata: {
          title: 'Self-Supervised Volumetric Transformer for 3D Brain MRI Segmentation',
          authors: ['Minh Nguyen', 'Sarah Jenkins'],
          year: 2024,
          doi: '10.1109/cvpr.2016.90',
        },
      });

      expect(res.updated).toBe(false);
      expect(res.rejectedCitedDoi).toBe('10.1109/cvpr.2016.90');
      expect(updateItemMock).toHaveBeenCalledTimes(1);
      const patchPassed = updateItemMock.mock.calls[0][2] as Record<string, unknown>;
      expect(patchPassed.doi).toBeNull();
      expect((patchPassed.extraFields as Record<string, unknown>).rejectedCitedDoi).toBe(
        '10.1109/cvpr.2016.90',
      );
    });
  });

  // =========================================================================
  // 3. VENUE & ITEMTYPE CROSS-CONTAMINATION GUARD
  // =========================================================================
  describe('3. Venue & ItemType Cross-Contamination Guard (Preprint vs Published)', () => {
    it('upgrades arXiv preprint to journalArticle when published in Nature, clearing repository/arXiv publisher while keeping arXiv ID in extra', () => {
      const coalesced = MetadataCoalescePolicy.coalesceCandidates([
        makeCandidate('arXiv', 0.92, {
          itemType: 'preprint',
          title: 'Highly accurate protein structure prediction with AlphaFold',
          authors: ['John Jumper', 'Richard Evans', 'Demis Hassabis'],
          arxivId: '2107.00001',
          doi: '10.48550/arXiv.2107.00001',
          repository: 'arXiv',
          publisher: 'arXiv',
          year: 2021,
        }),
        makeCandidate('CrossRef', 0.98, {
          itemType: 'journalArticle',
          title: 'Highly accurate protein structure prediction with AlphaFold',
          authors: ['John Jumper', 'Richard Evans', 'Demis Hassabis'],
          doi: '10.1038/s41586-021-03819-2',
          journal: 'Nature',
          publicationTitle: 'Nature',
          volume: '596',
          issue: '7873',
          pages: '583-589',
          year: 2021,
        }),
      ]);

      const item = coalesced.proposedItem;
      expect(item.itemType).toBe('journalArticle');
      expect(item.doi).toBe('10.1038/s41586-021-03819-2');
      expect(item.journal).toBe('Nature');
      expect(item.publicationTitle).toBe('Nature');
      expect(item.volume).toBe('596');
      expect(item.issue).toBe('7873');
      expect(item.pages).toBe('583-589');
      expect(item.repository).toBeUndefined();
      expect(item.publisher).toBeUndefined();
      expect(item.arxivId).toBe('2107.00001');
      expect(item.extra).toContain('arXiv: 2107.00001');
    });

    it('keeps a pure arXiv preprint as itemType="preprint" even if CrossRef/DataCite labels 10.48550/arXiv.* as journalArticle with venue="arXiv"', () => {
      const coalesced = MetadataCoalescePolicy.coalesceCandidates([
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

      const item = coalesced.proposedItem;
      expect(item.itemType).toBe('preprint');
      expect(item.arxivId).toBe('2402.09876');
      expect(item.repository).toBe('arXiv');
      expect(item.journal).toBeUndefined();
      expect(item.publicationTitle).toBeUndefined();
    });
  });

  // =========================================================================
  // 4. DATE & YEAR SYNCHRONIZATION ACCURACY
  // =========================================================================
  describe('4. Date & Year Synchronization Accuracy (No Desynchronized Year vs Date)', () => {
    it('synchronizes year, date, and publicationDate to the canonical publication date (2023-05-14) despite a 2026 PDF creation date', () => {
      const coalesced = MetadataCoalescePolicy.coalesceCandidates([
        makeCandidate(
          'LocalPDFExtraction',
          0.65,
          {
            title: 'Deterministic Consensus in Byzantine Fault-Tolerant Ledgers',
            authors: ['Hao Chen', 'Priya Patel'],
            year: 2026,
            publicationDate: '2026-01-10',
          },
          'FILE',
        ),
        makeCandidate('CrossRef', 0.96, {
          title: 'Deterministic Consensus in Byzantine Fault-Tolerant Ledgers',
          authors: ['Hao Chen', 'Priya Patel'],
          year: 2023,
          publicationDate: '2023-05-14',
          doi: '10.1145/3588888.3588999',
          journal: 'Journal of the ACM',
        }),
      ]);

      const item = coalesced.proposedItem as Record<string, unknown>;
      expect(item.year).toBe(2023);
      expect(item.publicationDate).toBe('2023-05-14');
      expect(item.date).toBe('2023-05-14');
    });
  });

  // =========================================================================
  // 5. IDENTIFIER CROSS-ASSIGNMENT & NORMALIZATION GUARD
  // =========================================================================
  describe('5. Identifier Cross-Assignment Guard (DOI, arXiv, PMID, PMCID, ISBN, ISSN)', () => {
    it('keeps all 5 distinct identifiers (DOI, PMID, PMCID, ISSN, arXiv) strictly in their own slots without cross-contamination', () => {
      const coalesced = MetadataCoalescePolicy.coalesceCandidates([
        makeCandidate('PubMed', 0.96, {
          itemType: 'journalArticle',
          title: 'CRISPR-Cas9 Base Editing in Human Hematopoietic Stem Cells',
          authors: ['Alexis Komor', 'David Liu'],
          pmid: '34567890',
          pmcid: 'PMC8765432',
          doi: '10.1056/nejmoa2109876',
          issn: '0028-4793',
          journal: 'New England Journal of Medicine',
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

      const item = coalesced.proposedItem;
      expect(item.doi).toBe('10.1056/nejmoa2109876');
      expect(item.pmid).toBe('34567890');
      expect(item.pmcid).toBe('PMC8765432');
      expect(item.issn).toBe('0028-4793');
      expect(item.arxivId).toBe('2111.05432');
      expect(item.isbn).toBeUndefined();
      expect(isSameCanonicalIdentifier('10.48550/arXiv.2111.05432v2', 'arXiv:2111.05432')).toBe(
        true,
      );
      expect(isSameCanonicalIdentifier('10.1056/NEJMoa2109876', '10.48550/arXiv.2111.05432')).toBe(
        false,
      );
    });
  });

  // =========================================================================
  // 6. MULTI-RECORD BATCH PARSING COUNT & ZERO FIELD BLEED
  // =========================================================================
  describe('6. Multi-Record Batch Parsing Count & Zero Field Bleed (BibTeX, RIS, NBIB, EndNote XML, CSV)', () => {
    it('parses 5 heterogeneous BibTeX entries with exact count=5 and zero field bleed between adjacent records', () => {
      const bibtexParser = new BibtexParser();
      const bibBatch = `
@article{rec1_2020,
  title = {First Paper on Quantum Error Correction},
  author = {Shor, Peter and Preskill, John},
  journal = {Physical Review Letters},
  year = {2020},
  volume = {124},
  pages = {010501},
  doi = {10.1103/PhysRevLett.124.010501},
  abstract = {We present a fault-tolerant quantum error correction protocol.},
  keywords = {quantum, codes}
}

@inproceedings{rec2_2021,
  title = {Second Paper on Neural Compiler Optimization},
  author = {Lattner, Chris},
  booktitle = {Proceedings of PLDI 2021},
  editor = {Torczon, Linda and Cooper, Keith},
  year = {2021},
  pages = {100--115}
}

@incollection{rec3_2022,
  title = {Third Entry as a Book Chapter Without DOI},
  author = {Lamport, Leslie},
  booktitle = {Distributed Systems: Past and Future},
  publisher = {ACM Press},
  year = {2022},
  isbn = {978-1-4503-9999-9}
}

@phdthesis{rec4_2023,
  title = {Fourth Entry PhD Dissertation on Formal Verification},
  author = {Ringer, Talia},
  school = {University of Washington},
  year = {2023}
}

@misc{rec5_2024,
  title = {Fifth Entry Preprint on Sparse Mixture of Experts},
  author = {Fedus, William and Zoph, Barret and Shazeer, Noam},
  eprint = {2403.54321},
  archivePrefix = {arXiv},
  primaryClass = {cs.LG},
  year = {2024}
}
`;
      const records = bibtexParser.parse(bibBatch);
      expect(records).toHaveLength(5);

      expect(records[0].itemType).toBe('journalArticle');
      expect(records[0].doi).toBe('10.1103/physrevlett.124.010501');
      expect(records[0].authors).toEqual(['Peter Shor', 'John Preskill']);
      expect(records[0].editors).toBeUndefined();
      expect(records[0].abstract).toBe(
        'We present a fault-tolerant quantum error correction protocol.',
      );
      expect(records[0].keywords).toEqual(['quantum', 'codes']);

      expect(records[1].itemType).toBe('conferencePaper');
      expect(records[1].authors).toEqual(['Chris Lattner']);
      expect(records[1].editors).toEqual(['Linda Torczon', 'Keith Cooper']);
      expect(records[1].doi).toBeUndefined();
      expect(records[1].abstract).toBeUndefined();
      expect(records[1].keywords).toBeUndefined();
      expect(records[1].proceedingsTitle).toBe('Proceedings of PLDI 2021');

      expect(records[2].itemType).toBe('bookSection');
      expect(records[2].authors).toEqual(['Leslie Lamport']);
      expect(records[2].editors).toBeUndefined();
      expect(records[2].isbn).toBe('978-1-4503-9999-9');
      expect(records[2].doi).toBeUndefined();

      expect(records[3].itemType).toBe('thesis');
      expect(records[3].university).toBe('University of Washington');
      expect(records[3].isbn).toBeUndefined();

      expect(records[4].itemType).toBe('preprint');
      expect(records[4].arxivId).toBe('2403.54321');
      expect(records[4].authors).toHaveLength(3);
      expect(records[4].university).toBeUndefined();
    });

    it('parses 4 RIS records with exact count=4 and zero state bleed across ER - boundaries', () => {
      const risParser = new RisParser();
      const risBatch = [
        'TY  - JOUR',
        'TI  - First RIS Journal Article',
        'AU  - Curien, Pierre-Louis',
        'A1  - Herbelin, Hugo',
        'JO  - Journal of Functional Programming',
        'PY  - 2020/03/15/',
        'VL  - 30',
        'IS  - 2',
        'SP  - 1',
        'EP  - 42',
        'DO  - 10.1017/S0956796820000015',
        'AB  - This study investigates the duality of computation in lambda calculi.',
        'KW  - lambda calculus',
        'KW  - duality',
        'ER  - ',
        '',
        'TY  - CONF',
        'TI  - Second RIS Conference Paper Without DOI or Abstract',
        'AU  - Wadler, Philip',
        'T2  - Proceedings of ICFP 2021',
        'A2  - Harper, Robert',
        'PY  - 2021',
        'SP  - 55',
        'EP  - 68',
        'ER  - ',
        '',
        'TY  - THES',
        'TI  - Third RIS Doctoral Thesis',
        'AU  - Girard, Jean-Yves',
        'PB  - Universite Paris VII',
        'M3  - PhD Dissertation',
        'PY  - 1972',
        'ER  - ',
        '',
        'TY  - RPRT',
        'TI  - Fourth RIS Technical Report',
        'AU  - Milner, Robin',
        'PB  - University of Edinburgh',
        'IS  - ECS-LFCS-88-46',
        'PY  - 1988',
        'ER  - ',
      ].join('\n');

      const records = risParser.parse(risBatch);
      expect(records).toHaveLength(4);

      expect(records[0].itemType).toBe('journalArticle');
      expect(records[0].authors).toEqual(['Pierre-Louis Curien', 'Hugo Herbelin']);
      expect(records[0].doi).toBe('10.1017/s0956796820000015');
      expect(records[0].abstract).toBe(
        'This study investigates the duality of computation in lambda calculi.',
      );
      expect(records[0].keywords).toEqual(['lambda calculus', 'duality']);

      expect(records[1].itemType).toBe('conferencePaper');
      expect(records[1].authors).toEqual(['Philip Wadler']);
      expect(records[1].editors).toEqual(['Robert Harper']);
      expect(records[1].doi).toBeUndefined();
      expect(records[1].abstract).toBeUndefined();
      expect(records[1].keywords ?? []).toHaveLength(0);

      expect(records[2].itemType).toBe('thesis');
      expect(records[2].authors).toEqual(['Jean-Yves Girard']);
      expect(records[2].editors).toBeUndefined();
      expect(records[2].university).toBe('Universite Paris VII');

      expect(records[3].itemType).toBe('report');
      expect(records[3].authors).toEqual(['Robin Milner']);
      expect(records[3].reportNumber).toBe('ECS-LFCS-88-46');
      expect(records[3].issue).toBeUndefined();
    });

    it('parses 3 PubMed NBIB records, 3 EndNote XML records, and 4 CSV rows with exact counts and zero field bleed', () => {
      const legacyParser = new XmlLegacyFormatsParser();

      const nbibBatch = [
        'PMID- 31000001',
        'TI  - First PubMed Clinical Trial on mRNA Vaccines',
        'FAU - Kariko, Katalin',
        'FAU - Weissman, Drew',
        'JT  - Nature Medicine',
        'DP  - 2021 Apr',
        'LID - 10.1038/s41591-021-00001-1 [doi]',
        'PMC - PMC7000001',
        'AB  - Nucleoside-modified mRNA vaccine clinical trial results.',
        'MH  - mRNA Vaccine',
        '',
        'PMID- 31000002',
        'TI  - Second PubMed Observational Study Without PMC or Abstract',
        'FAU - Fauci, Anthony S',
        'JT  - The Lancet',
        'DP  - 2022 Nov',
        'LID - 10.1016/S0140-6736(22)00002-2 [doi]',
        '',
        'PMID- 31000003',
        'TI  - Third PubMed Case Report Without DOI',
        'FAU - Ho, David D',
        'JT  - JAMA',
        'DP  - 2023 Jan',
      ].join('\n');

      const nbibRecords = legacyParser.parseMedlineNbib(nbibBatch);
      expect(nbibRecords).toHaveLength(3);
      expect(nbibRecords[0].pmid).toBe('31000001');
      expect(nbibRecords[0].pmcid).toBe('PMC7000001');
      expect(nbibRecords[0].doi).toBe('10.1038/s41591-021-00001-1');
      expect(nbibRecords[0].authors).toEqual(['Kariko, Katalin', 'Weissman, Drew']);
      expect(nbibRecords[0].creators?.map((c) => `${c.firstName} ${c.lastName}`)).toEqual([
        'Katalin Kariko',
        'Drew Weissman',
      ]);
      expect(nbibRecords[0].abstract).toBe(
        'Nucleoside-modified mRNA vaccine clinical trial results.',
      );

      expect(nbibRecords[1].pmid).toBe('31000002');
      expect(nbibRecords[1].pmcid).toBeUndefined();
      expect(nbibRecords[1].abstract).toBeUndefined();
      expect(nbibRecords[1].keywords ?? []).toHaveLength(0);
      expect(nbibRecords[1].authors).toEqual(['Fauci, Anthony S']);

      expect(nbibRecords[2].pmid).toBe('31000003');
      expect(nbibRecords[2].doi).toBeUndefined();
      expect(nbibRecords[2].authors).toEqual(['Ho, David D']);

      const endnoteXml = `<?xml version="1.0" encoding="UTF-8"?>
<xml><records>
  <record>
    <ref-type name="Journal Article">17</ref-type>
    <titles><title>EndNote Record One</title><secondary-title>Science</secondary-title></titles>
    <contributors><authors><author>Doudna, Jennifer A.</author><author>Charpentier, Emmanuelle</author></authors></contributors>
    <dates><year>2012</year></dates>
    <electronic-resource-num>10.1126/science.1225829</electronic-resource-num>
    <abstract>CRISPR endonuclease programmable cleavage study.</abstract>
  </record>
  <record>
    <ref-type name="Book Section">5</ref-type>
    <titles><title>EndNote Record Two Chapter</title><secondary-title>Methods in Enzymology</secondary-title></titles>
    <contributors>
      <authors><author>Zhang, Feng</author></authors>
      <secondary-authors><author>Church, George M.</author></secondary-authors>
    </contributors>
    <dates><year>2014</year></dates>
    <isbn>978-0-12-800202-5</isbn>
  </record>
  <record>
    <ref-type name="Thesis">32</ref-type>
    <titles><title>EndNote Record Three Thesis</title></titles>
    <contributors><authors><author>Hsu, Patrick D.</author></authors></contributors>
    <publisher>Harvard University</publisher>
    <dates><year>2015</year></dates>
  </record>
</records></xml>`;

      const xmlRecords = legacyParser.parseEndnoteXml(endnoteXml);
      expect(xmlRecords).toHaveLength(3);
      expect(xmlRecords[0].itemType).toBe('journalArticle');
      expect(xmlRecords[0].doi).toBe('10.1126/science.1225829');
      expect(xmlRecords[0].editors).toBeUndefined();

      expect(xmlRecords[1].itemType).toBe('bookSection');
      expect(xmlRecords[1].authors).toEqual(['Zhang, Feng']);
      expect(xmlRecords[1].editors).toEqual(['Church, George M.']);
      expect(xmlRecords[1].creators?.map((c) => `${c.creatorType}:${c.firstName} ${c.lastName}`)).toEqual([
        'author:Feng Zhang',
        'editor:George M. Church',
      ]);
      expect(xmlRecords[1].doi).toBeUndefined();
      expect(xmlRecords[1].abstract).toBeUndefined();
      expect(xmlRecords[1].journal).toBeUndefined();
      expect(xmlRecords[1].bookTitle).toBe('Methods in Enzymology');

      expect(xmlRecords[2].itemType).toBe('thesis');
      expect(xmlRecords[2].university).toBe('Harvard University');
      expect(xmlRecords[2].isbn).toBeUndefined();

      const csvBatch = [
        'Item Type,Title,Author,Publication Year,DOI,Publication Title,ISBN',
        'journalArticle,"CSV Paper One","Hinton, Geoffrey; LeCun, Yann; Bengio, Yoshua",2015,10.1038/nature14539,Nature,',
        'book,"CSV Book Two","Goodfellow, Ian; Bengio, Yoshua; Courville, Aaron",2016,,,978-0262035613',
        'conferencePaper,"CSV Paper Three","He, Kaiming; Sun, Jian",2016,10.1109/CVPR.2016.90,CVPR,',
        'preprint,"CSV Preprint Four","Radford, Alec",2023,,,',
      ].join('\n');

      const csvRecords = legacyParser.parseCsvBibliography(csvBatch);
      expect(csvRecords).toHaveLength(4);
      expect(csvRecords[0].authors).toHaveLength(3);
      expect(csvRecords[0].doi).toBe('10.1038/nature14539');
      expect(csvRecords[1].itemType).toBe('book');
      expect(csvRecords[1].doi).toBeUndefined();
      expect(csvRecords[1].isbn).toBe('9780262035613');
      expect(csvRecords[2].itemType).toBe('conferencePaper');
      expect(csvRecords[2].isbn).toBeUndefined();
      expect(csvRecords[3].itemType).toBe('preprint');
      expect(csvRecords[3].doi).toBeUndefined();
    });
  });

  // =========================================================================
  // 7. EXTRACTION -> CATALOG SYNC & ENRICHMENT PATCH PROTECTION
  // =========================================================================
  describe('7. Extraction -> Catalog Sync & Enrichment Patch Protection (User Locks & Multi-Author Guard)', () => {
    it('prevents background PDF extraction or enrichment from overwriting user-locked fields or downgrading 5 authors to 1 author', async () => {
      const fiveAuthors = [
        'Alice Zhang',
        'Bob Rossi',
        'Carlos Mendez',
        'Diana Novak',
        'Ethan Okafor',
      ];
      const existingCatalogItem = {
        id: 'item-locked-1',
        title: 'User Curated Canonical Title',
        itemType: 'journalArticle',
        year: 2024,
        doi: '10.1038/s41586-024-00001-x',
        publicationTitle: 'Nature',
        journal: 'Nature',
        authors: fiveAuthors,
        creators: fiveAuthors.map((fullName, idx) => ({
          creatorType: 'author',
          fullName,
          orderIndex: idx,
        })),
        metadata: {
          lockedFields: ['title', 'year'],
          fieldProvenance: {
            title: { source: 'manual', sourceProvider: 'manual', confidence: 1.0, isUserOverride: true },
            year: { source: 'manual', sourceProvider: 'manual', confidence: 1.0, isUserOverride: true },
            authors: { source: 'arXiv', sourceProvider: 'arXiv', confidence: 0.92 },
          },
        },
        extraFields: {
          lockedFields: ['title', 'year'],
          fieldProvenance: {
            title: { source: 'manual', sourceProvider: 'manual', confidence: 1.0, isUserOverride: true },
            year: { source: 'manual', sourceProvider: 'manual', confidence: 1.0, isUserOverride: true },
            authors: { source: 'arXiv', sourceProvider: 'arXiv', confidence: 0.92 },
          },
        },
      };

      // 7a. Extraction sync plan must respect existing authoritative fields and locked fields
      const syncPlan = buildExtractedMetadataSyncPlan(
        {
          id: 'att-1',
          itemId: 'item-locked-1',
          item: existingCatalogItem,
        },
        {
          metadata: {
            title: 'downloaded_paper_v3_final.pdf',
            authors: ['A. Zhang'],
            year: 2019,
            abstract: 'Newly extracted high-precision abstract from the PDF body.',
            volume: '625',
            pages: '112-120',
          },
        },
      );

      expect(syncPlan.itemPatch.title).toBeUndefined();
      expect(syncPlan.itemPatch.year).toBeUndefined();
      expect(syncPlan.itemPatch.abstract).toBe(
        'Newly extracted high-precision abstract from the PDF body.',
      );
      expect(syncPlan.metaPatch.volume).toBe('625');
      expect(syncPlan.metaPatch.pages).toBe('112-120');

      // 7b. Fresh-state sanitizer blocks stale extraction updates if user locked or edited concurrently
      const sanitized = await sanitizeExtractedItemUpdateAgainstFreshState({
        data: {
          ...syncPlan.itemPatch,
          title: 'Stale Extraction Title Attempt',
          year: 2019,
        },
        freshItem: existingCatalogItem,
      });
      expect(sanitized.sanitizedData.title).toBeUndefined();
      expect(sanitized.sanitizedData.year).toBeUndefined();
      expect(sanitized.sanitizedData.abstract).toBe(
        'Newly extracted high-precision abstract from the PDF body.',
      );

      // 7c. Enrichment patch must NEVER downgrade 5 existing authors to a truncated 1-author list even from CrossRef
      const enrichPatch = buildEnrichmentPatch(existingCatalogItem, {
        title: 'CrossRef Variant Title',
        year: 2023,
        authors: ['Alice Zhang'], // Truncated 1-author record in upstream feed
        creators: [{ creatorType: 'author', fullName: 'Alice Zhang', orderIndex: 0 }],
        issue: '7995',
        sourceProvider: 'CrossRef',
      });

      expect(enrichPatch.title).toBeUndefined(); // Locked by user
      expect(enrichPatch.year).toBeUndefined(); // Locked by user
      expect(enrichPatch.authors).toBeUndefined(); // Protected against 5 -> 1 author truncation downgrade!
      expect(enrichPatch.creators).toBeUndefined(); // Protected against 5 -> 1 creator truncation downgrade!
      expect(enrichPatch.issue).toBe('7995'); // Missing scalar field is enriched cleanly

      // 7d. Re-resolve patch also respects lockedFields while upgrading unlocked fields
      const reResolve = buildReResolvePatch(existingCatalogItem, {
        title: 'Re-Resolved Title Should Be Blocked By Lock',
        year: 2022,
        publisher: 'Springer Nature',
        sourceProvider: 'CrossRef',
      });

      expect(reResolve.updateData.title).toBeUndefined();
      expect(reResolve.updateData.year).toBeUndefined();
      expect(reResolve.updateData.publisher).toBe('Springer Nature');
    });
  });
});
