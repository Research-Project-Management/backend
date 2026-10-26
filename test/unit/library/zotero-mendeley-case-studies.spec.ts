import { BibtexParser } from '@/modules/library/ingestion/parsers/bibtex.parser';
import { RisParser } from '@/modules/library/ingestion/parsers/ris.parser';
import { CslParser } from '@/modules/library/ingestion/parsers/csl.parser';
import { NormalizationPolicy } from '@/modules/library/ingestion/policies/normalization.policy';
import { DuplicatePolicy } from '@/modules/library/ingestion/policies/duplicate.policy';
import {
  DuplicateService,
  DuplicateDetectorService,
  DuplicateMergerService,
} from '@/modules/library/ingestion/services/duplicate.service';
import { RetractionService } from '@/modules/library/ingestion/services/retraction.service';
import { RetractionScannerProvider } from '@/modules/library/ingestion/providers/retraction-scanner.provider';
import { RetractionDatabaseService } from '@/modules/library/ingestion/services/retraction-database.service';
import { CslJsonMapper } from '@/modules/library/citation/domain/csl-json.mapper';
import { CslEngineService } from '@/modules/library/citation/services/csl-engine.service';
import { CitationService } from '@/modules/library/citation/services/citation.service';
import { ExportsService } from '@/modules/library/citation/services/exports.service';
import { PdfBakerService } from '@/modules/library/citation/services/pdf-baker.service';
import { ConditionEvaluatorEngine } from '@/modules/library/catalog/domain/condition-evaluator.engine';
import { TreeEngine } from '@/modules/library/catalog/domain/tree.engine';
import { formatLiteratureNoteMarkdown } from '@/modules/library/catalog/domain/notes.domain';
import { TagsService } from '@/modules/library/catalog/services/tags.service';
import { TagsRepository } from '@/modules/library/catalog/repositories/tags.repository';
import { CollectionsService } from '@/modules/library/catalog/services/collections.service';
import {
  parseCreatorString,
  splitAuthorString,
  stripLatexBraces,
} from '@/modules/library/core';

describe('Real-World Zotero & Mendeley Datasets + User Case-Study Stress Test Suite', () => {
  // CASE STUDY 1: Zotero / Mendeley Multi-Format Bulk Migration & Round-Trip
  describe('Case Study 1: Zotero / Mendeley BibTeX, RIS & CSL-JSON Bulk Import + Round-Trip Export', () => {
    const bibtexParser = new BibtexParser();
    const risParser = new RisParser();
    const cslParser = new CslParser();
    const normPolicy = new NormalizationPolicy();
    const cslEngine = new CslEngineService();
    const citationService = new CitationService(undefined, cslEngine);

    const REAL_ZOTERO_MENDELEY_BIBTEX = `
@article{vaswani2017attention,
  author = {Vaswani, Ashish and Shazeer, Noam and Parmar, Niki and Uszkoreit, Jakob and Jones, Llion and Gomez, Aidan N. and Kaiser, {\\L}ukasz and Polosukhin, Illia},
  title = {{Attention} Is All You Need: Complexity $\\mathcal{O}(n^{2})$ in {NLP}},
  journal = {Advances in Neural Information Processing Systems},
  volume = {30},
  pages = {5998--6008},
  year = {2017},
  doi = {https://doi.org/10.5555/3295222.3295349},
  keywords = {Transformers; Self-Attention, Deep Learning},
  file = {:Users/researcher/Zotero/storage/ABCD1234/Vaswani_2017_Attention.pdf:PDF}
}

@inproceedings{scholkopf2021causal,
  author = {Sch{\\"o}lkopf, Bernhard and Locatello, Francesco and Bauer, Stefan and Ke, Nan Rosemary and Kalchbrenner, Nal and Goyal, Anirudh and Bengio, Yoshua and others},
  title = {Toward Causal Representation Learning with {G{\\"o}del} and {B{\\'e}zier} Networks},
  booktitle = {Proceedings of the IEEE},
  volume = {109},
  number = {5},
  pages = {612--634},
  year = {2021},
  doi = {10.1109/JPROC.2021.3058954}
}

@online{touvron2023llama,
  author = {Touvron, Hugo and Lavril, Thibaut and Izacard, Gautier and Martinet, Xavier and Lachaux, Marie-Anne and Lacroix, Timoth{\\'e}e and Rozi{\\\`e}re, Baptiste},
  title = {{LLaMA}: Open and Efficient Foundation Language Models},
  year = {2023},
  eprint = {2302.13971},
  archivePrefix = {arXiv},
  primaryClass = {cs.CL},
  url = {https://arxiv.org/abs/2302.13971}
}

@book{who2024global,
  author = {{World Health Organization}},
  editor = {Van Der Waals, Johannes Diderik and Gates, Jr., Bill and {\\v{S}}im{\\r{u}}nek, J. and Nguy{\\~e}n, V{\\u{a}}n An},
  title = {Global Genomic Surveillance Strategy for Pathogens with Pandemic and Epidemic Potential},
  publisher = {World Health Organization},
  address = {Geneva, Switzerland},
  edition = {2nd},
  isbn = {978-92-4-004697-9},
  year = {2024}
}

@phdthesis{nguyen2022quantum,
  author = {Nguyễn, Văn An},
  title = {Fault-Tolerant Quantum Error Correction with Surface Codes},
  school = {Massachusetts Institute of Technology},
  address = {Cambridge, MA},
  year = {2022}
}
`;

    it('1.1 parses complex Zotero/Mendeley BibTeX with LaTeX diacritics, math blocks, eprint/arXiv, corporate authors, and "and others"', () => {
      const parsed = bibtexParser.parse(REAL_ZOTERO_MENDELEY_BIBTEX);
      expect(parsed).toHaveLength(5);

      // Entry 1: Vaswani 2017 — math block preserved, Łukasz decoded, file path extracted, DOI normalized
      const vaswani = parsed.find(
        (e) => e.citationKey === 'vaswani2017attention',
      )!;
      expect(vaswani).toBeDefined();
      expect(vaswani.itemType).toBe('journalArticle');
      expect(vaswani.title).toContain('$\\mathcal{O}(n^{2})$');
      expect(vaswani.title).toContain('Attention Is All You Need');
      expect(vaswani.authors).toEqual(
        expect.arrayContaining(['Łukasz Kaiser']),
      );
      expect(vaswani.doi).toBe('10.5555/3295222.3295349');
      expect(vaswani.fileUrl).toBe(
        'Users/researcher/Zotero/storage/ABCD1234/Vaswani_2017_Attention.pdf',
      );
      expect(vaswani.keywords).toEqual([
        'Transformers',
        'Self-Attention',
        'Deep Learning',
      ]);

      // Normalize through NormalizationPolicy
      const { notes: _vaswaniNotes, ...vaswaniMeta } = vaswani;
      const normVaswani = normPolicy.normalize(vaswaniMeta);
      expect(normVaswani.pages).toBe('5998-6008');
      expect(normVaswani.title).toContain('$\\mathcal{O}(n^{2})$');

      // Entry 2: Schölkopf 2021 — LaTeX umlauts & acute accents decoded, "and others" filtered out
      const scholkopf = parsed.find(
        (e) => e.citationKey === 'scholkopf2021causal',
      )!;
      expect(scholkopf).toBeDefined();
      expect(scholkopf.itemType).toBe('conferencePaper');
      expect(scholkopf.title).toContain('Gödel');
      expect(scholkopf.title).toContain('Bézier');
      expect(scholkopf.authors[0]).toContain('Schölkopf');
      expect(scholkopf.authors.some((a) => /others/i.test(a))).toBe(false);

      // Entry 3: Touvron 2023 (@online + eprint + archivePrefix=arXiv -> itemType: 'preprint', arxivId preserved)
      const llama = parsed.find((e) => e.citationKey === 'touvron2023llama')!;
      expect(llama).toBeDefined();
      expect(llama.itemType).toBe('preprint');
      expect(llama.arxivId).toBe('2302.13971');
      expect(llama.authors).toEqual(
        expect.arrayContaining(['Timothée Lacroix', 'Baptiste Rozière']),
      );

      // Entry 4: WHO 2024 Book — corporate author + complex editors (Van Der Waals, Gates Jr., Šimůnek)
      const whoBook = parsed.find((e) => e.citationKey === 'who2024global')!;
      expect(whoBook).toBeDefined();
      expect(whoBook.itemType).toBe('book');
      expect(whoBook.isbn).toBe('978-92-4-004697-9');
      const { notes: _whoNotes, ...whoMeta } = whoBook;
      const normWho = normPolicy.normalize(whoMeta);
      const orgCreator = normWho.creators?.find(
        (c) => c.creatorType === 'author',
      );
      expect(orgCreator?.fieldMode).toBe(1);
      expect(orgCreator?.fullName).toBe('World Health Organization');

      // Entry 5: PhD Thesis -> itemType: 'thesis'
      const thesis = parsed.find((e) => e.citationKey === 'nguyen2022quantum')!;
      expect(thesis.itemType).toBe('thesis');
      expect(thesis.year).toBe(2022);
    });

    it('1.2 parses multi-record EndNote/Mendeley RIS with multi-line AB, PY date slashes, DO URLs, ED editors, and SP/EP page ranges', () => {
      const REAL_MENDELEY_RIS = `
TY  - JOUR
TI  - Deep Residual Learning for Image Recognition
AU  - He, Kaiming
AU  - Zhang, Xiangyu
AU  - Ren, Shaoqing
AU  - Sun, Jian
JO  - 2016 IEEE Conference on Computer Vision and Pattern Recognition (CVPR)
PY  - 2016/06/27//
VL  - 1
IS  - 2
SP  - 770
EP  - 778
DO  - https://doi.org/10.1109/CVPR.2016.90
KW  - Deep Learning
KW  - Residual Networks
KW  - Computer Vision
N1  - Winner of CVPR 2016 Best Paper Award
AB  - Deeper neural networks are more difficult to train.
We present a residual learning framework to ease the training of networks
that are substantially deeper than those used previously.
We explicitly reformulate the layers as learning residual functions with reference to the layer inputs.
ER  - 

TY  - CHAP
T1  - Approximate Bayesian Computation in Population Genetics
A1  - Beaumont, Mark A.
ED  - Balding, David J.
ED  - Moltke, Ida
T2  - Handbook of Statistical Genomics
PB  - John Wiley & Sons
CY  - Chichester, UK
ET  - 4th
PY  - 2019///
SP  - 415
EP  - 442
SN  - 9781119429142
DO  - doi:10.1002/9781119487845.ch15
ER  - 
`;

      const items = risParser.parse(REAL_MENDELEY_RIS);
      expect(items).toHaveLength(2);

      const resnet = items[0];
      expect(resnet.title).toBe('Deep Residual Learning for Image Recognition');
      expect(resnet.year).toBe(2016);
      expect(resnet.doi).toBe('10.1109/cvpr.2016.90');
      expect(resnet.pages).toBe('770-778');
      expect(resnet.authors).toHaveLength(4);
      // Multi-line abstract must retain all 3 continuation lines, not truncate after line 1
      expect(resnet.abstract).toContain(
        'Deeper neural networks are more difficult to train.',
      );
      expect(resnet.abstract).toContain(
        'We explicitly reformulate the layers as learning residual functions',
      );
      expect(resnet.notes?.[0]?.content).toContain(
        'Winner of CVPR 2016 Best Paper Award',
      );

      const chap = items[1];
      expect(chap.itemType).toBe('bookSection');
      expect(chap.year).toBe(2019);
      expect(chap.doi).toBe('10.1002/9781119487845.ch15');
      expect(chap.editors).toEqual(
        expect.arrayContaining(['Balding, David J.', 'Moltke, Ida']),
      );
      expect(chap.place).toBe('Chichester, UK');
      expect(chap.edition).toBe('4th');
    });

    it('1.3 handles author name parsing quirks: particles, suffixes, Vietnamese names, corporate authors, and Vancouver format', () => {
      // 1. "gates, bill, jr." and "Gates, Jr., Bill"
      const gates1 = parseCreatorString('Gates, Bill, Jr.');
      expect(gates1.lastName).toBe('Gates');
      expect(gates1.firstName).toBe('Bill Jr.');
      expect(gates1.fullName).toBe('Bill Gates Jr.');

      const gates2 = parseCreatorString('Gates, Jr., Bill');
      expect(gates2.lastName).toBe('Gates');
      expect(gates2.firstName).toBe('Bill Jr.');
      expect(gates2.fullName).toBe('Bill Gates Jr.');

      // 2. Multi-part particles: "Van Der Waals, Johannes Diderik" and "María José de la Cruz"
      const vdw = parseCreatorString('Van Der Waals, Johannes Diderik');
      expect(vdw.lastName).toBe('Van Der Waals');
      expect(vdw.firstName).toBe('Johannes Diderik');

      const vdwForward = parseCreatorString('Johannes Diderik Van Der Waals');
      expect(vdwForward.lastName).toBe('Van Der Waals');
      expect(vdwForward.firstName).toBe('Johannes Diderik');

      const cruz = parseCreatorString('María José de la Cruz');
      expect(cruz.lastName).toBe('de la Cruz');
      expect(cruz.firstName).toBe('María José');

      // 3. Vietnamese name: "Nguyễn Văn An"
      const vn = parseCreatorString('Nguyễn Văn An');
      expect(vn.lastName).toBe('Nguyễn');
      expect(vn.firstName).toBe('Văn An');

      // 4. Corporate author in double braces: "{{World Health Organization}}"
      const who = parseCreatorString('{{World Health Organization}}');
      expect(who.fieldMode).toBe(1);
      expect(who.fullName).toBe('World Health Organization');

      // 5. splitAuthorString ignores BibTeX "and others" / "et al."
      const splitList = splitAuthorString(
        'Vaswani, Ashish and Shazeer, Noam and others',
      );
      expect(splitList).toEqual(['Vaswani, Ashish', 'Shazeer, Noam']);
    });

    it('1.4 executes lossless round-trip export (Item -> CSL-JSON / BibTeX / RIS -> Re-parse)', () => {
      const sourceItem = {
        id: 'item-roundtrip-1',
        itemType: 'journalArticle',
        citationKey: 'lecun2015deep',
        title: 'Deep learning',
        year: 2015,
        publicationTitle: 'Nature',
        volume: '521',
        issue: '7553',
        pages: '436-444',
        doi: '10.1038/nature14539',
        publisher: 'Nature Publishing Group',
        abstract:
          'Deep learning allows computational models that are composed of multiple processing layers to learn representations of data with multiple levels of abstraction.',
        contributors: [
          {
            firstName: 'Yann',
            lastName: 'LeCun',
            fullName: 'Yann LeCun',
            creatorType: 'author',
            orderIndex: 0,
          },
          {
            firstName: 'Yoshua',
            lastName: 'Bengio',
            fullName: 'Yoshua Bengio',
            creatorType: 'author',
            orderIndex: 1,
          },
          {
            firstName: 'Geoffrey',
            lastName: 'Hinton',
            fullName: 'Geoffrey Hinton',
            creatorType: 'author',
            orderIndex: 2,
          },
        ],
      };

      // Export to CSL-JSON and re-parse via CslParser
      const cslData = CslJsonMapper.toCsl(sourceItem);
      const reparsedFromCsl = cslParser.parse([
        cslData as unknown as Record<string, unknown>,
      ]);
      expect(reparsedFromCsl).toHaveLength(1);
      expect(reparsedFromCsl[0].title).toBe('Deep learning');
      expect(reparsedFromCsl[0].doi).toBe('10.1038/nature14539');
      expect(reparsedFromCsl[0].year).toBe(2015);
      expect(reparsedFromCsl[0].volume).toBe('521');
      expect(reparsedFromCsl[0].issue).toBe('7553');
      expect(reparsedFromCsl[0].pages).toBe('436-444');
      expect(reparsedFromCsl[0].authors).toEqual([
        'Yann LeCun',
        'Yoshua Bengio',
        'Geoffrey Hinton',
      ]);

      // Export to BibTeX and re-parse via BibtexParser
      const bibtexOut =
        citationService.formatItem(sourceItem, 'bibtex').bibliography ?? '';
      const reparsedFromBibtex = bibtexParser.parse(bibtexOut);
      expect(reparsedFromBibtex).toHaveLength(1);
      expect(reparsedFromBibtex[0].title.toLowerCase()).toBe('deep learning');
      expect(reparsedFromBibtex[0].doi).toBe('10.1038/nature14539');
      expect(reparsedFromBibtex[0].year).toBe(2015);
      expect(reparsedFromBibtex[0].volume).toBe('521');

      // Export to RIS and re-parse via RisParser
      const risOut =
        citationService.formatItem(sourceItem, 'ris').bibliography ?? '';
      const reparsedFromRis = risParser.parse(risOut);
      expect(reparsedFromRis).toHaveLength(1);
      expect((reparsedFromRis[0].title ?? '').toLowerCase()).toBe(
        'deep learning',
      );
      expect(reparsedFromRis[0].doi).toBe('10.1038/nature14539');
      expect(reparsedFromRis[0].year).toBe(2015);
    });
  });

  // CASE STUDY 2: Duplicate Detection & Smart Merge (Zotero "Duplicate Items")
  describe('Case Study 2: Duplicate Detection & Non-Destructive Smart Merge', () => {
    const duplicatePolicy = new DuplicatePolicy();

    it('2.1 detects true duplicates (DOI variations, arXiv version suffixes, Preprint 2023 vs Published 2024) while rejecting false positives ("Part I" vs "Part II", "Supplementary Material")', async () => {
      // 1. DuplicatePolicy evaluation: Preprint (2023) vs Published (2024) with inverted vs forward author name
      const existingPreprint = {
        id: 'item-preprint-2023',
        title:
          'Direct Preference Optimization: Your Language Model is Secretly a Reward Model',
        year: 2023,
        authors: ['Rafailov, Rafael', 'Sharma, Archit'],
      };
      const proposedPublished = {
        title:
          'Direct Preference Optimization: Your Language Model Is Secretly a Reward Model!',
        year: 2024,
        authors: ['Rafael Rafailov', 'Archit Sharma'],
      };

      const matchResult = duplicatePolicy.evaluate(proposedPublished, [
        existingPreprint,
      ]);
      expect(matchResult.matchType).toBe('PROBABLE');
      expect(matchResult.targetItemId).toBe('item-preprint-2023');
      expect(matchResult.evidence?.yearMatch).toBe(true);
      expect(matchResult.evidence?.authorMatch).toBe(true);

      // 2. False Positive Guard: "Part I" vs "Part II" by same author in same year
      const part1 = {
        id: 'item-part-1',
        title: 'Stochastic Differential Equations in High Dimensions: Part I',
        year: 2024,
        authors: ['Hairer, Martin'],
      };
      const part2 = {
        title: 'Stochastic Differential Equations in High Dimensions: Part II',
        year: 2024,
        authors: ['Martin Hairer'],
      };
      expect(duplicatePolicy.evaluate(part2, [part1]).matchType).toBe(
        'NO_MATCH',
      );

      // 3. False Positive Guard: Main paper vs "Supplementary Material" / "Erratum"
      const supplement = {
        title:
          'Direct Preference Optimization: Your Language Model is Secretly a Reward Model - Supplementary Material',
        year: 2023,
        authors: ['Rafael Rafailov'],
      };
      expect(
        duplicatePolicy.evaluate(supplement, [existingPreprint]).matchType,
      ).toBe('NO_MATCH');

      // 4. DuplicateService.detectDuplicates across a realistic multi-item workspace
      const mockCatalogGateway = {
        findDuplicateCandidateItems: jest.fn().mockResolvedValue([
          // Cluster 1: DOI variation (https://doi.org/10.1038/s41586-021-03819-2 vs 10.1038/S41586-021-03819-2)
          {
            id: 'alphafold-1',
            title:
              'Highly accurate protein structure prediction with AlphaFold',
            doi: 'https://doi.org/10.1038/s41586-021-03819-2',
            year: 2021,
            authors: ['John Jumper', 'Richard Evans'],
          },
          {
            id: 'alphafold-2',
            title:
              'Highly Accurate Protein Structure Prediction with AlphaFold',
            doi: '10.1038/S41586-021-03819-2',
            year: 2021,
            authors: ['Jumper, John'],
          },
          // Cluster 2: arXiv version variation (arXiv:2303.08774v1 vs 2303.08774v4)
          {
            id: 'gpt4-v1',
            title: 'GPT-4 Technical Report',
            arxivId: 'arXiv:2303.08774v1',
            year: 2023,
            authors: ['OpenAI'],
          },
          {
            id: 'gpt4-v4',
            title: 'GPT-4 Technical Report',
            arxivId: '2303.08774v4',
            year: 2024,
            authors: ['OpenAI'],
          },
          // Cluster 3: Fuzzy Title + Year (+/-1) + First Author (Preprint 2023 vs Conf 2024 without shared DOI)
          {
            id: 'dpo-2023',
            title:
              'Direct Preference Optimization: Your Language Model is Secretly a Reward Model',
            year: 2023,
            authors: ['Rafailov, Rafael'],
          },
          {
            id: 'dpo-2024',
            title:
              'Direct Preference Optimization — Your Language Model Is Secretly a Reward Model',
            year: 2024,
            authors: ['Rafael Rafailov'],
          },
          // Distinct items sharing first 3 title words ("Large Language Models...") and author/year -> MUST NOT cluster!
          {
            id: 'llm-code',
            title: 'Large Language Models for Automated Code Repair in Rust',
            year: 2024,
            authors: ['Chen, Mark'],
          },
          {
            id: 'llm-medical',
            title: 'Large Language Models for Clinical Differential Diagnosis',
            year: 2024,
            authors: ['Chen, Mark'],
          },
          // Distinct Part I vs Part II -> MUST NOT cluster!
          {
            id: 'quantum-part-1',
            title:
              'Topological Quantum Computation with Majorana Zero Modes: Part I',
            year: 2024,
            authors: ['Kitaev, Alexei'],
          },
          {
            id: 'quantum-part-2',
            title:
              'Topological Quantum Computation with Majorana Zero Modes: Part II',
            year: 2024,
            authors: ['Kitaev, Alexei'],
          },
        ]),
      };

      const dupService = new DuplicateService(
        new DuplicateDetectorService(mockCatalogGateway as never),
        new DuplicateMergerService({} as never, mockCatalogGateway as never),
      );
      const clusters = await dupService.detectDuplicates('user-1');

      expect(clusters).toHaveLength(3);
      const reasons = clusters.map((c) => c.matchReason).sort();
      expect(reasons).toEqual([
        'EXACT_ARXIV',
        'EXACT_DOI',
        'FUZZY_TITLE_YEAR_AUTHOR',
      ]);
      // Ensure non-duplicates were not clustered
      const allClusteredIds = clusters.flatMap((c) => c.items.map((i) => i.id));
      expect(allClusteredIds).not.toContain('llm-code');
      expect(allClusteredIds).not.toContain('llm-medical');
      expect(allClusteredIds).not.toContain('quantum-part-1');
      expect(allClusteredIds).not.toContain('quantum-part-2');
    });

    it('2.2 performs atomic smart merge consolidating attachments, notes, tags, collections, citationKey aliases, and backfilled fields', async () => {
      const primaryItem = {
        id: 'primary-id',
        title: 'Attention Is All You Need',
        itemType: 'journalArticle',
        year: 2017,
        citationKey: 'vaswani2017attention',
        doi: null,
        abstract: null,
        publicationTitle: 'NeurIPS',
        metadata: {},
        contributors: [
          {
            firstName: 'Ashish',
            lastName: 'Vaswani',
            fullName: 'Ashish Vaswani',
            creatorType: 'author',
            orderIndex: 0,
          },
        ],
      };

      const duplicateItem = {
        id: 'dup-id',
        title: 'Attention Is All You Need',
        itemType: 'journalArticle',
        year: 2017,
        citationKey: 'vaswani_attention_2017',
        doi: '10.5555/3295222.3295349',
        abstract:
          'The dominant sequence transduction models are based on complex recurrent or convolutional neural networks.',
        publicationTitle: 'Advances in Neural Information Processing Systems',
        publisher: 'Curran Associates, Inc.',
        volume: '30',
        pages: '5998-6008',
        metadata: {},
        contributors: [],
      };

      const mockTx = {
        $executeRaw: jest.fn().mockResolvedValue(1),
        itemRelation: {
          findMany: jest.fn().mockResolvedValue([
            // Self-relation after merge -> should be deleted
            {
              id: 'rel-self',
              sourceItemId: 'dup-id',
              targetItemId: 'primary-id',
              relationType: 'related',
            },
            // External relation on duplicate -> should be rewired to primary
            {
              id: 'rel-ext',
              sourceItemId: 'dup-id',
              targetItemId: 'other-paper-id',
              relationType: 'cites',
            },
          ]),
          delete: jest.fn().mockResolvedValue({}),
          update: jest.fn().mockResolvedValue({}),
        },
        userPublication: {
          findMany: jest.fn().mockResolvedValue([]),
        },
        itemMetadata: {
          findFirst: jest.fn().mockResolvedValue(null),
          update: jest.fn().mockResolvedValue({}),
          deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        },
        contributor: {
          count: jest.fn().mockResolvedValue(1),
          deleteMany: jest.fn(),
          createMany: jest.fn(),
        },
        item: {
          update: jest.fn().mockImplementation(({ where, data }) => ({
            id: where.id,
            ...data,
            version: 2,
          })),
          findUnique: jest.fn().mockResolvedValue({
            ...primaryItem,
            doi: '10.5555/3295222.3295349',
            abstract: duplicateItem.abstract,
            version: 2,
          }),
        },
      };

      const mockHelpers = {
        appendChange: jest.fn().mockResolvedValue(undefined),
        publishOutbox: jest.fn().mockResolvedValue(undefined),
        recordTombstone: jest.fn().mockResolvedValue(undefined),
      };

      const mockLibraryTx = {
        executeInTransaction: jest
          .fn()
          .mockImplementation((cb) => cb(mockTx, mockHelpers)),
      };

      const mockCatalogGateway = {
        findByIds: jest.fn().mockResolvedValue([primaryItem, duplicateItem]),
        mergeItems: jest.fn().mockResolvedValue(undefined),
      };

      const mockExtractionGateway = {
        reassignContentToItem: jest.fn().mockResolvedValue(undefined),
      };

      const dupService = new DuplicateService(
        new DuplicateDetectorService(
          mockCatalogGateway as never,
          undefined,
          mockLibraryTx as never,
        ),
        new DuplicateMergerService(
          mockLibraryTx as never,
          mockCatalogGateway as never,
          mockExtractionGateway as never,
        ),
      );

      await dupService.mergeDuplicates('user-1', {
        primaryItemId: 'primary-id',
        duplicateItemIds: ['dup-id'],
        fieldSelections: {
          publicationTitle: 'Advances in Neural Information Processing Systems',
        },
      });

      // 1. Attachments and notes reassigned via ExtractionGateway
      expect(mockExtractionGateway.reassignContentToItem).toHaveBeenCalledWith(
        ['dup-id'],
        'primary-id',
        mockTx,
      );
      // 2. Tags, collections, and user states merged via CatalogGateway
      expect(mockCatalogGateway.mergeItems).toHaveBeenCalledWith(
        mockTx,
        ['dup-id'],
        'primary-id',
      );
      // 3. Self-relation deleted, external relation rewired
      expect(mockTx.itemRelation.delete).toHaveBeenCalledWith({
        where: { id: 'rel-self' },
      });
      expect(mockTx.itemRelation.update).toHaveBeenCalledWith({
        where: { id: 'rel-ext' },
        data: { sourceItemId: 'primary-id', targetItemId: 'other-paper-id' },
      });
      // 4. Primary item updated with backfilled DOI, abstract, volume, pages, and mergedCitationKeys alias
      const primaryUpdateCall = mockTx.item.update.mock.calls.find(
        (call: Array<{ where: { id: string } }>) =>
          call[0].where.id === 'primary-id',
      )?.[0];
      expect(primaryUpdateCall.data.doi).toBe('10.5555/3295222.3295349');
      expect(primaryUpdateCall.data.abstract).toBe(duplicateItem.abstract);
      expect(primaryUpdateCall.data.publicationTitle).toBe(
        'Advances in Neural Information Processing Systems',
      );
      expect(primaryUpdateCall.data.metadata.volume).toBe('30');
      expect(primaryUpdateCall.data.metadata.pages).toBe('5998-6008');
      expect(primaryUpdateCall.data.metadata.mergedCitationKeys).toContain(
        'vaswani_attention_2017',
      );
      // 5. Duplicate item soft-deleted with mergedIntoId pointer and tombstone
      const dupUpdateCall = mockTx.item.update.mock.calls.find(
        (call: Array<{ where: { id: string } }>) =>
          call[0].where.id === 'dup-id',
      )?.[0];
      expect(dupUpdateCall.data.deletedAt).toBeInstanceOf(Date);
      expect(dupUpdateCall.data.metadata.mergedIntoId).toBe('primary-id');
      expect(mockHelpers.recordTombstone).toHaveBeenCalledWith(
        expect.anything(),
        { entityType: 'Item', entityId: 'dup-id' },
      );
    });
  });

  // CASE STUDY 3: Saved Searches (Smart Collections), Hierarchical Folders & Tags
  describe('Case Study 3: Saved Searches (Smart Collections), Hierarchical Subcollection Roll-Up & Tag Curation', () => {
    it('3.1 compiles nested Saved Search AST with matchMode (all/any), snake_case operators, recursive subcollections, and isStarred/readStatus', async () => {
      const mockPrisma = {
        collection: {
          findMany: jest.fn().mockResolvedValue([
            { id: 'col-phd', parentId: null },
            { id: 'col-ch1', parentId: 'col-phd' },
            { id: 'col-transformers', parentId: 'col-ch1' },
            { id: 'col-unrelated', parentId: null },
          ]),
        },
      };

      const evaluator = new ConditionEvaluatorEngine(
        mockPrisma as never,
        new TreeEngine(),
      );

      // Complex Zotero Smart Collection query:
      // Match ALL:
      // - collection IS 'col-phd' (with recursive subcollections enabled -> col-phd, col-ch1, col-transformers)
      // - Match ANY: itemType IS 'journalArticle' OR itemType IS 'conferencePaper'
      // - year greater_than 2020
      // - hasPdf is_present
      // - tag does_not_contain 'archived'
      // - author contains 'Vaswani'
      // - readStatus is_not 'read'
      // - isStarred is true
      const compiled = await evaluator.compile('user-1', {
        matchMode: 'all',
        scopeOptions: {
          searchSubcollections: true,
          showOnlyTopLevel: true,
        },
        conditions: [
          { field: 'collection', operator: 'is', value: 'col-phd' },
          {
            matchMode: 'any',
            conditions: [
              { field: 'itemType', operator: 'is', value: 'journalArticle' },
              { field: 'itemType', operator: 'is', value: 'conferencePaper' },
            ],
          },
          { field: 'year', operator: 'greater_than', value: 2020 },
          { field: 'hasPdf', operator: 'is_present' },
          { field: 'tag', operator: 'does_not_contain', value: 'archived' },
          { field: 'author', operator: 'contains', value: 'Vaswani' },
          { field: 'readStatus', operator: 'is_not', value: 'read' },
          { field: 'isStarred', operator: 'is', value: true },
        ],
      });

      const jsonStr = JSON.stringify(compiled);
      // Recursive subcollections resolved
      expect(jsonStr).toContain(
        '"in":["col-phd","col-ch1","col-transformers"]',
      );
      // Nested OR group for itemType
      expect(jsonStr).toContain(
        '{"OR":[{"itemType":"journalArticle"},{"itemType":"conferencePaper"}]}',
      );
      // Year > 2020
      expect(jsonStr).toContain('{"year":{"gt":2020}}');
      // hasPdf -> attachments some {}
      expect(jsonStr).toContain('{"attachments":{"some":{"deletedAt":null}}}');
      // tag does_not_contain 'archived'
      expect(jsonStr).toContain(
        '"name":{"contains":"archived","mode":"insensitive"}',
      );
      // author contains 'Vaswani' on fullName
      expect(jsonStr).toContain(
        '"fullName":{"contains":"Vaswani","mode":"insensitive"}',
      );
      // isStarred state check
      expect(jsonStr).toContain('"isStarred":true');
      // showOnlyTopLevel filter
      expect(jsonStr).toContain('"notIn":["attachment","annotation","note"]');
    });

    it('3.2 prevents cycles when reparenting collections and merges duplicate tags case-insensitively without duplicate itemTag links', async () => {
      const treeEngine = new TreeEngine();
      const nodes = [
        { id: 'col-phd', parentId: null },
        { id: 'col-ch1', parentId: 'col-phd' },
        { id: 'col-transformers', parentId: 'col-ch1' },
      ];

      // Reparenting root `col-phd` under its own grandchild `col-transformers` must be detected as a cycle
      expect(treeEngine.detectCycle(nodes, 'col-phd', 'col-transformers')).toBe(
        true,
      );
      expect(() =>
        treeEngine.assertNoCycle(nodes, 'col-phd', 'col-transformers'),
      ).toThrow(/Circular collection hierarchy detected/);
      // Reparenting `col-transformers` under `col-phd` is valid (no cycle)
      expect(treeEngine.detectCycle(nodes, 'col-transformers', 'col-phd')).toBe(
        false,
      );

      // Tag merge / rename collision: renaming "machine-learning" -> "Machine Learning" when both exist on item-shared
      const sourceTag = {
        id: 'tag-source',
        name: 'machine-learning',
        color: '#ff0000',
        userId: 'user-1',
        projectId: null,
      };
      const targetTag = {
        id: 'tag-target',
        name: 'Machine Learning',
        color: '#00ff00',
        userId: 'user-1',
        projectId: null,
      };

      const mockTx = {
        tag: {
          findFirst: jest
            .fn()
            .mockResolvedValueOnce(sourceTag)
            .mockResolvedValueOnce(targetTag),
          delete: jest.fn().mockResolvedValue(sourceTag),
          update: jest.fn().mockResolvedValue(targetTag),
        },
        itemTag: {
          findMany: jest.fn().mockImplementation(({ where }) => {
            if (where.tagId === 'tag-source') {
              return Promise.resolve([
                { itemId: 'item-shared' },
                { itemId: 'item-only-source' },
              ]);
            }
            return Promise.resolve([{ itemId: 'item-shared' }]);
          }),
          createMany: jest.fn().mockResolvedValue({ count: 1 }),
          deleteMany: jest.fn().mockResolvedValue({ count: 2 }),
        },
      };

      const mockLibraryTx = {
        executeInTransaction: jest.fn().mockImplementation((cb) =>
          cb(mockTx, {
            appendChange: jest.fn(),
            publishOutbox: jest.fn(),
            recordTombstone: jest.fn(),
          }),
        ),
      };

      const tagsRepo = new TagsRepository(mockTx as never);
      const tagsService = new TagsService(tagsRepo, mockLibraryTx as never);
      const merged = await tagsService.updateTag('user-1', 'tag-source', {
        name: 'Machine Learning',
      });

      // Only item-only-source should be linked to tag-target (item-shared already has tag-target)
      expect(mockTx.itemTag.createMany).toHaveBeenCalledWith({
        data: [{ itemId: 'item-only-source', tagId: 'tag-target' }],
        skipDuplicates: true,
      });
      expect(mockTx.tag.delete).toHaveBeenCalledWith({
        where: { id: 'tag-source' },
      });
      expect(merged.id).toBe('tag-target');
    });
  });

  // CASE STUDY 4: Citation Formatting Across Academic Styles & LaTeX Sync
  describe('Case Study 4: Multi-Style Citation Engine (APA, IEEE, Vancouver, Chicago, MLA, Harvard) & LaTeX Bibliography Sync', () => {
    const cslEngine = new CslEngineService();
    const citationService = new CitationService(undefined, cslEngine);

    const DIVERSE_ITEMS = [
      // 1. Journal article with 20+ authors (triggers et al. truncation in APA/IEEE/Vancouver)
      {
        id: 'atlas2012higgs',
        citationKey: 'atlas2012higgs',
        itemType: 'journalArticle',
        title:
          'Observation of a new particle in the search for the Standard Model Higgs boson with the ATLAS detector at the LHC',
        publicationTitle: 'Physics Letters B',
        volume: '716',
        issue: '1',
        pages: '1-29',
        year: 2012,
        doi: '10.1016/j.physletb.2012.08.020',
        authors: Array.from(
          { length: 25 },
          (_, i) => `AuthorSurname${i + 1}, Given${i + 1}`,
        ),
      },
      // 2. Edited book with editors only (no primary author) and edition
      {
        id: 'balding2019handbook',
        citationKey: 'balding2019handbook',
        itemType: 'book',
        title: 'Handbook of Statistical Genomics',
        publisher: 'John Wiley & Sons',
        place: 'Chichester, UK',
        edition: '4',
        year: 2019,
        isbn: '978-1-119-42914-2',
        contributors: [
          {
            firstName: 'David J.',
            lastName: 'Balding',
            creatorType: 'editor',
            orderIndex: 0,
          },
          {
            firstName: 'Ida',
            lastName: 'Moltke',
            creatorType: 'editor',
            orderIndex: 1,
          },
          {
            firstName: 'John',
            lastName: 'Marioni',
            creatorType: 'editor',
            orderIndex: 2,
          },
        ],
      },
      // 3. Webpage with accessDate
      {
        id: 'openai2024safety',
        citationKey: 'openai2024safety',
        itemType: 'webpage',
        title: 'Preparedness Framework (Beta)',
        publicationTitle: 'OpenAI',
        url: 'https://openai.com/safety/preparedness',
        year: 2024,
        accessedAt: '2024-09-15',
        contributors: [
          {
            fullName: 'OpenAI Safety Team',
            fieldMode: 1,
            creatorType: 'author',
            orderIndex: 0,
          },
        ],
      },
      // 4. arXiv Preprint with version number
      {
        id: 'touvron2023llama',
        citationKey: 'touvron2023llama',
        itemType: 'preprint',
        title: 'LLaMA: Open and Efficient Foundation Language Models',
        repository: 'arXiv',
        arxivId: '2302.13971v1',
        url: 'https://arxiv.org/abs/2302.13971',
        year: 2023,
        authors: ['Hugo Touvron', 'Thibaut Lavril', 'Gautier Izacard'],
      },
    ];

    it('4.1 formats 20+ author articles, edited books, webpages with accessDate, and preprints across APA, IEEE, Vancouver, Chicago, MLA, and Harvard', () => {
      const styles = [
        'apa',
        'ieee',
        'vancouver',
        'chicago',
        'mla',
        'harvard',
      ] as const;

      for (const style of styles) {
        for (const item of DIVERSE_ITEMS) {
          const formatted = citationService.formatItem(item, style);
          expect(formatted.bibliography).toBeTruthy();
          expect(formatted.bibliography).not.toMatch(/undefined|NaN|\[object/i);
          expect(formatted.inText).toBeTruthy();
          expect(formatted.inText).not.toMatch(/undefined|NaN|\[object/i);
        }
      }

      // Specific assertions on edited book (editors rendered with Ed. / Eds.)
      const apaBook = citationService.formatItem(DIVERSE_ITEMS[1], 'apa');
      expect(apaBook.bibliography).toContain('Balding');
      expect(apaBook.bibliography).toMatch(/Ed\.|Eds\./);
      expect(apaBook.bibliography).toContain(
        'Handbook of Statistical Genomics',
      );

      // Specific assertions on webpage with accessDate (csl.accessed populated)
      const cslWebpage = CslJsonMapper.toCsl(DIVERSE_ITEMS[2]);
      expect(cslWebpage.accessed).toEqual({
        'date-parts': [[2024, 9, 15]],
      });
      const harvardWeb = citationService.formatItem(
        DIVERSE_ITEMS[2],
        'harvard',
      );
      expect(harvardWeb.bibliography).toContain(
        'https://openai.com/safety/preparedness',
      );
    });

    it('4.2 resolves foundKeys and missingKeys accurately in exportByCitationKeys for LaTeX \\cite{...} sync', async () => {
      const dbItems = [
        {
          id: '11111111-1111-4111-8111-111111111111',
          citationKey: 'vaswani2017attention',
          itemType: 'journalArticle',
          title: 'Attention Is All You Need',
          year: 2017,
          publicationTitle: 'NeurIPS',
          doi: '10.5555/3295222.3295349',
          url: null,
          abstract: null,
          version: 1,
          updatedAt: new Date('2025-01-01T00:00:00Z'),
          metadata: {
            volume: '30',
            pages: '5998-6008',
            publisher: 'Curran Associates',
          },
          contributors: [
            {
              firstName: 'Ashish',
              lastName: 'Vaswani',
              fullName: 'Ashish Vaswani',
              creatorType: 'author',
              orderIndex: 0,
            },
          ],
          attachments: [],
        },
      ];

      const mockExportsRepo = {
        findItemsByScope: jest.fn().mockResolvedValue(dbItems),
      };

      const exportsService = new ExportsService(
        mockExportsRepo as never,
        citationService,
        new PdfBakerService(),
      );

      const syncResult = await exportsService.exportByCitationKeys('user-1', [
        'Vaswani2017Attention', // mixed-case match
        'missing2025ghost', // missing citation key
      ]);

      expect(syncResult.count).toBe(1);
      expect(syncResult.foundKeys).toEqual(['vaswani2017attention']);
      expect(syncResult.missingKeys).toEqual(['missing2025ghost']);
      expect(syncResult.content).toContain('@article{vaswani2017attention');
      expect(syncResult.content).toContain('volume = {30}');
      expect(syncResult.content).toContain('5998');
    });
  });

  // CASE STUDY 5: PDF Annotation Extraction & Retraction Watch Alerting
  describe('Case Study 5: PDF Highlight-to-Note Extraction & Retraction Watch Alerting', () => {
    it('5.1 extracts PDF highlights & comments sorted by page + Zotero sortIndex, grouped by semantic color with deep backlinks', () => {
      const item = {
        id: 'item-attention-id',
        title: 'Attention Is All You Need',
        citekey: 'vaswani2017attention',
        year: 2017,
        doi: '10.5555/3295222.3295349',
        creators: [
          { firstName: 'Ashish', lastName: 'Vaswani' },
          { firstName: 'Noam', lastName: 'Shazeer' },
        ],
      };

      // Deliberately out-of-order annotations across pages and vertical Y positions
      const annotations = [
        {
          id: 'ann-p2-bottom',
          attachmentId: 'att-pdf-1',
          pageIndex: 1, // Page 2
          annotationSortIndex: '00001|000500|00120',
          color: '#ff6666', // Red -> Critical
          quoteText:
            'Recurrent models typically factor computation along the symbol positions of the input and output sequences.',
          comment: 'Key bottleneck of RNNs preventing parallelization.',
        },
        {
          id: 'ann-p1-bottom',
          attachmentId: 'att-pdf-1',
          pageIndex: 0, // Page 1
          annotationSortIndex: '00000|000420|00080',
          color: '#5fb236', // Green -> Methods
          quoteText:
            'We propose a new simple network architecture, the Transformer, based solely on attention mechanisms.',
          comment: null,
        },
        {
          id: 'ann-p1-top',
          attachmentId: 'att-pdf-1',
          pageIndex: 0, // Page 1 (higher up on page: y=150 < y=420)
          annotationSortIndex: '00000|000150|00080',
          color: '#ffd400', // Yellow -> Key Points
          quoteText:
            'The dominant sequence transduction models are based on complex recurrent or convolutional neural networks.',
          comment: 'Opening thesis statement.',
        },
      ];

      // 1. Flux protocol backlinks
      const markdownFlux = formatLiteratureNoteMarkdown(item, annotations, {
        protocol: 'flux',
      });
      expect(markdownFlux).toContain(
        '# Literature Notes: Attention Is All You Need',
      );
      expect(markdownFlux).toContain('**@citekey:** vaswani2017attention');
      expect(markdownFlux).toContain('### Page 1');
      expect(markdownFlux).toContain('### Page 2');
      expect(markdownFlux).toContain('#### 🟡 Key Points');
      expect(markdownFlux).toContain('#### 🟢 Methods');
      expect(markdownFlux).toContain('#### 🔴 Critical');

      // Verify sort order: ann-p1-top (y=150) appears BEFORE ann-p1-bottom (y=420), which appears BEFORE ann-p2-bottom (page 2)
      const idxP1Top = markdownFlux.indexOf('Opening thesis statement.');
      const idxP1Bottom = markdownFlux.indexOf(
        'We propose a new simple network architecture',
      );
      const idxP2Bottom = markdownFlux.indexOf(
        'Key bottleneck of RNNs preventing parallelization.',
      );
      expect(idxP1Top).toBeGreaterThan(0);
      expect(idxP1Bottom).toBeGreaterThan(idxP1Top);
      expect(idxP2Bottom).toBeGreaterThan(idxP1Bottom);

      // Verify deep-link citation format
      expect(markdownFlux).toContain(
        '[(Vaswani et al., 2017, p. 1)](flux://open-pdf/library/items/att-pdf-1?page=1&annotation=ann-p1-top)',
      );

      // 2. Zotero protocol backlinks
      const markdownZotero = formatLiteratureNoteMarkdown(item, annotations, {
        protocol: 'zotero',
      });
      expect(markdownZotero).toContain(
        'zotero://open-pdf/0_att-pdf-1/1?annotation=ann-p1-top',
      );
    });

    it('5.2 detects retracted papers in workspace even when DOI has URL/prefix formatting and persists retraction details', async () => {
      const mockRetractionRepo = {
        findManyRetractionRecords: jest.fn().mockResolvedValue([]),
        findRetractionRecord: jest.fn().mockImplementation(({ OR }) => {
          // Only matches normalized bare DOI '10.1016/s0140-6736(97)11096-0'
          const queriedDoi = OR?.[0]?.doi;
          if (queriedDoi === '10.1016/s0140-6736(97)11096-0') {
            return Promise.resolve({
              doi: '10.1016/s0140-6736(97)11096-0',
              isRetracted: true,
              noticeType: 'retraction',
              reason:
                'Fraudulent data fabrication and ethical violations (Wakefield et al., Lancet)',
              noticeUrl: 'https://doi.org/10.1016/S0140-6736(10)60175-4',
              retractionDate: new Date('2010-02-02T00:00:00Z'),
              source: 'retraction_watch',
            });
          }
          return Promise.resolve(null);
        }),
        upsertRetractionRecord: jest.fn().mockResolvedValue({}),
        findItemById: jest.fn().mockResolvedValue({
          id: 'item-wakefield-1998',
          userId: 'user-1',
          title:
            'Ileal-lymphoid-nodular hyperplasia, non-specific colitis, and pervasive developmental disorder in children',
          // Stored with full URL prefix and uppercase characters
          doi: 'https://doi.org/10.1016/S0140-6736(97)11096-0',
          metadata: {},
        }),
        findItemsForScan: jest.fn().mockResolvedValue([
          {
            id: 'item-wakefield-1998',
            doi: 'https://doi.org/10.1016/S0140-6736(97)11096-0',
            pmid: null,
            isRetracted: false,
            retractionNature: null,
          },
        ]),
        updateItemRetraction: jest.fn().mockResolvedValue(undefined),
      };

      const retractionDb = new RetractionDatabaseService(
        mockRetractionRepo as never,
      );
      const scanner = new RetractionScannerProvider(retractionDb);

      const retractionService = new RetractionService(
        mockRetractionRepo as never,
        scanner,
        retractionDb,
        {} as never,
      );

      // 1. Check single item with URL-prefixed DOI
      const itemCheck = await retractionService.checkItem(
        'user-1',
        'item-wakefield-1998',
      );
      expect(itemCheck.isRetracted).toBe(true);
      expect(itemCheck.status).toBe('retracted');
      expect(itemCheck.nature).toBe('retraction');
      expect(itemCheck.details?.reason).toContain(
        'Fraudulent data fabrication',
      );

      // 2. Batch library scan
      const batchResult = await retractionService.checkLibrary('user-1');
      expect(batchResult.scanned).toBe(1);
      expect(batchResult.newlyRetracted).toBe(1);

      expect(mockRetractionRepo.updateItemRetraction).toHaveBeenCalledWith(
        'item-wakefield-1998',
        true,
        'retraction',
        expect.objectContaining({
          nature: 'retraction',
          source: 'retraction_watch',
          reason: expect.stringContaining('Fraudulent data fabrication'),
        }),
        expect.any(Date),
      );
    });
  });
});
