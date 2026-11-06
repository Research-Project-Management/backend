import {
  buildCommandCreateInput,
  buildCommandUpdateInput,
  buildImportItemPayload,
  type ImportSourceItem,
} from '@/modules/library/catalog/domain/item-command.mapper';
import {
  calculateIdentifierChanges,
  normalizeItemIdentifiers,
} from '@/modules/library/catalog/domain/identifier-change.domain';
import { ItemTypeConversionService } from '@/modules/library/catalog/services/item-type-conversion.service';
import { ItemTransformer } from '@/modules/library/catalog/services/item.transformer';
import { TypesService } from '@/modules/library/catalog/services/schema-validator.service';
import {
  ItemsMapper,
  type CreateItemData,
  type ItemDetail,
  type UpdateItemData,
} from '@/modules/library/core';

const TEST_USER_ID = '01950000-0000-7000-8000-000000000001';
const TEST_PROJECT_ID = '01950000-0000-7000-8000-000000000099';

interface SimulatedDbItemRow {
  id: string; userId: string; projectId: string | null; title: string; itemType: string;
  year: number | null; citationKey: string | null; doi: string | null; isbn: string | null;
  issn: string | null; pmid: string | null; pmcid: string | null; arxivId: string | null;
  publicationTitle: string | null; abstract: string | null; url: string | null;
  firstAuthor: string | null; isRetracted: boolean; retractionCheckedAt: Date | null;
  hasFile: boolean; attachmentCount: number; noteCount: number; version: number;
  createdAt: Date; updatedAt: Date; deletedAt: Date | null; metadata: Record<string, unknown>;
  contributors: Array<{
    id: string; creatorType: string; fieldMode: number; firstName: string | null;
    lastName: string | null; fullName: string; shortName: string | null; orderIndex: number;
  }>;
  identifiers: Array<{ id: string; type: string; value: string; canonicalUri: string | null }>;
  itemTags: Array<{ type: string; tag: { id: string; name: string; color: string | null; type: string } }>;
  collectionItems: Array<{ collectionId: string; collection: { id: string; name: string } }>;
  attachments: Array<Record<string, unknown>>; notesList: Array<Record<string, unknown>>;
  states: Array<{ isRead: boolean; isStarred: boolean }>; publications: Array<Record<string, unknown>>;
  outgoingRel: Array<Record<string, unknown>>; incomingRel: Array<Record<string, unknown>>;
}

function simulateCreateAndRead(
  input: CreateItemData,
  projectId?: string,
): { row: SimulatedDbItemRow; domain: ItemDetail } {
  const resolvedTags = (input.tags || []).map((t, idx) => {
    const name = typeof t === 'string' ? t : t.name;
    const type = typeof t === 'object' && t?.type === 'automatic' ? 'automatic' : 'manual';
    return { id: `01950000-0000-7000-8000-00000000100${idx}`, name, type };
  });
  const built = buildCommandCreateInput(TEST_USER_ID, input, { resolvedTags }, projectId);
  const cd = built.createData;
  const rawContribs = (cd.contributors as { create?: Array<{
    creatorType?: string; fieldMode?: number; firstName?: string | null;
    lastName?: string | null; fullName: string; shortName?: string | null; orderIndex?: number;
  }> } | undefined)?.create ?? [];

  const row: SimulatedDbItemRow = {
    id: '01950000-0000-7000-8000-000000000100', userId: TEST_USER_ID,
    projectId: (cd.projectId as string | null) ?? null, title: cd.title,
    itemType: cd.itemType ?? 'journalArticle', year: cd.year ?? null,
    citationKey: cd.citationKey ?? null, doi: cd.doi ?? null, isbn: cd.isbn ?? null,
    issn: cd.issn ?? null, pmid: cd.pmid ?? null, pmcid: cd.pmcid ?? null,
    arxivId: cd.arxivId ?? null, publicationTitle: cd.publicationTitle ?? null,
    abstract: cd.abstract ?? null, url: cd.url ?? null, firstAuthor: cd.firstAuthor ?? null,
    isRetracted: Boolean(cd.isRetracted), retractionCheckedAt: (cd.retractionCheckedAt as Date | null) ?? null,
    hasFile: Boolean(cd.hasFile), attachmentCount: cd.attachmentCount ?? 0,
    noteCount: cd.noteCount ?? 0, version: 1,
    createdAt: new Date('2026-03-01T10:00:00.000Z'), updatedAt: new Date('2026-03-01T10:00:00.000Z'),
    deletedAt: null, metadata: structuredClone((cd.metadata as Record<string, unknown>) ?? {}),
    contributors: rawContribs.map((c, idx) => ({
      id: `01950000-0000-7000-8000-00000000200${idx}`, creatorType: c.creatorType ?? 'author',
      fieldMode: c.fieldMode ?? 0, firstName: c.firstName ?? '', lastName: c.lastName ?? '',
      fullName: c.fullName, shortName: c.shortName ?? '', orderIndex: c.orderIndex ?? idx,
    })),
    identifiers: built.identifiersToCreate.map((ident, idx) => ({
      id: `01950000-0000-7000-8000-00000000300${idx}`, type: ident.type,
      value: ident.value, canonicalUri: ident.canonicalUri ?? null,
    })),
    itemTags: resolvedTags.map((rt) => ({
      type: rt.type, tag: { id: rt.id, name: rt.name, color: null, type: rt.type },
    })),
    collectionItems: [], attachments: [], notesList: [],
    states: [{ isRead: false, isStarred: false }],
    publications: [], outgoingRel: [], incomingRel: [],
  };
  return { row, domain: ItemsMapper.toDomain(structuredClone(row)) };
}

function simulateUpdateAndRead(
  existingRow: SimulatedDbItemRow,
  patch: UpdateItemData,
): { row: SimulatedDbItemRow; domain: ItemDetail } {
  const existingDomain = ItemsMapper.toDomain(structuredClone(existingRow));
  const built = buildCommandUpdateInput(
    TEST_USER_ID,
    {
      ...existingDomain, metadata: structuredClone(existingRow.metadata),
      contributors: structuredClone(existingRow.contributors),
      identifiers: structuredClone(existingRow.identifiers),
    } as ItemDetail,
    patch,
  );
  const ud = built.updateData;
  const nextRow: SimulatedDbItemRow = structuredClone(existingRow);
  const scalarCols = [
    'title', 'itemType', 'year', 'citationKey', 'doi', 'isbn', 'issn',
    'pmid', 'pmcid', 'arxivId', 'publicationTitle', 'abstract', 'url', 'firstAuthor',
  ] as const;
  for (const col of scalarCols) {
    if (ud[col] !== undefined) (nextRow as unknown as Record<string, unknown>)[col] = ud[col] ?? null;
  }
  if (ud.isRetracted !== undefined) nextRow.isRetracted = Boolean(ud.isRetracted);
  if (ud.metadata !== undefined) nextRow.metadata = structuredClone(ud.metadata as Record<string, unknown>);
  nextRow.version += 1;

  const contribChange = ud.contributors as {
    deleteMany?: Record<string, unknown>;
    create?: Array<{
      creatorType?: string; fieldMode?: number; firstName?: string | null;
      lastName?: string | null; fullName: string; shortName?: string | null; orderIndex?: number;
    }>;
  } | undefined;
  if (contribChange?.deleteMany) {
    nextRow.contributors = (contribChange.create ?? []).map((c, idx) => ({
      id: `01950000-0000-7000-8000-00000000400${idx}`, creatorType: c.creatorType ?? 'author',
      fieldMode: c.fieldMode ?? 0, firstName: c.firstName ?? '', lastName: c.lastName ?? '',
      fullName: c.fullName, shortName: c.shortName ?? '', orderIndex: c.orderIndex ?? idx,
    }));
  }

  const idChanges = calculateIdentifierChanges(
    built.cleanIds, existingRow as unknown as Record<string, unknown>, patch.identifiers,
  );
  for (const ch of idChanges) {
    nextRow.identifiers = nextRow.identifiers.filter((i) => i.type !== ch.type);
    if (ch.value) {
      nextRow.identifiers.push({
        id: `01950000-0000-7000-8000-0000000050${nextRow.identifiers.length}`,
        type: ch.type, value: ch.value, canonicalUri: ch.canonicalUri ?? null,
      });
    }
  }
  return { row: nextRow, domain: ItemsMapper.toDomain(structuredClone(nextRow)) };
}

describe('End-to-End Metadata Input -> Persistence -> Output Round-Trip Pipeline', () => {
  describe('1. Multi-Type Bibliographic Field Fidelity (14 Zotero/CSL Item Types)', () => {
    it('preserves all journalArticle fields, identifiers, metrics, and dates without loss or format corruption', () => {
      const { domain } = simulateCreateAndRead({
        title: 'Attention Is All You Need', itemType: 'journalArticle', year: 2017,
        publicationDate: '2017-12-06', publicationTitle: 'Advances in Neural Information Processing Systems',
        journalAbbreviation: 'NeurIPS', volume: '30', issue: '2', pages: '5998-6008',
        section: 'Deep Learning', partNumber: 'Part I', partTitle: 'Sequence Transduction',
        series: 'NIPS Proceedings', seriesTitle: 'Advances in AI', seriesText: 'Annual NeurIPS Series',
        publisher: 'Curran Associates, Inc.', place: 'Long Beach, CA', language: 'en-US',
        shortTitle: 'Attention', citationKey: 'vaswani2017attention',
        doi: 'https://doi.org/10.5555/3295222.3295349', issn: '10495258',
        pmid: 'PMID: 32952220', pmcid: 'PMC7654321', arxivId: 'arXiv:1706.03762v7',
        url: 'https://proceedings.neurips.cc/paper/7181-attention', accessedAt: '2026-02-15T08:30:00.000Z',
        rights: 'CC-BY-4.0', license: 'CC-BY-4.0', libraryCatalog: 'Semantic Scholar',
        archive: 'arXiv', archiveLocation: 'cs.CL', callNumber: 'QA76.87 .V37 2017',
        citationCount: 145000, referenceCount: 42, influentialCitationCount: 19200,
        openAccessPdfUrl: 'https://arxiv.org/pdf/1706.03762.pdf',
        abstract: 'The dominant sequence transduction models are based on neural networks.',
        creators: [
          { firstName: 'Ashish', lastName: 'Vaswani', creatorType: 'author' },
          { firstName: 'Noam', lastName: 'Shazeer', creatorType: 'author' },
        ],
      });

      expect(domain).toMatchObject({
        title: 'Attention Is All You Need', itemType: 'journalArticle', year: 2017,
        publicationDate: '2017-12-06', date: '2017-12-06',
        publicationTitle: 'Advances in Neural Information Processing Systems',
        journalAbbreviation: 'NeurIPS', volume: '30', issue: '2', pages: '5998-6008',
        section: 'Deep Learning', partNumber: 'Part I', partTitle: 'Sequence Transduction',
        series: 'NIPS Proceedings', seriesTitle: 'Advances in AI', seriesText: 'Annual NeurIPS Series',
        publisher: 'Curran Associates, Inc.', place: 'Long Beach, CA', language: 'en-US',
        shortTitle: 'Attention', citationKey: 'vaswani2017attention',
        doi: '10.5555/3295222.3295349', DOI: '10.5555/3295222.3295349',
        issn: '1049-5258', ISSN: '1049-5258', pmid: '32952220', PMID: '32952220',
        pmcid: 'PMC7654321', PMCID: 'PMC7654321', arxivId: '1706.03762v7',
        accessDate: '2026-02-15T08:30:00.000Z', rights: 'CC-BY-4.0', license: 'CC-BY-4.0',
        libraryCatalog: 'Semantic Scholar', archive: 'arXiv', archiveLocation: 'cs.CL',
        callNumber: 'QA76.87 .V37 2017', citationCount: 145000, referenceCount: 42,
        influentialCitationCount: 19200, openAccessPdfUrl: 'https://arxiv.org/pdf/1706.03762.pdf',
      });
    });

    it('preserves type-specific fields across conferencePaper, book, bookSection, thesis, report, and preprint', () => {
      const conf = simulateCreateAndRead({
        title: 'Deep Residual Learning for Image Recognition', itemType: 'conferencePaper', year: 2016,
        proceedingsTitle: '2016 IEEE CVPR', conferenceName: 'IEEE CVPR 2016',
        eventPlace: 'Las Vegas, NV, USA', publisher: 'IEEE', place: 'Piscataway, NJ',
        pages: '770-778', series: 'CVPR Proceedings', doi: '10.1109/CVPR.2016.90', isbn: '978-1-4673-8851-1',
      }).domain;
      expect(conf).toMatchObject({
        proceedingsTitle: '2016 IEEE CVPR', publicationTitle: '2016 IEEE CVPR',
        conferenceName: 'IEEE CVPR 2016', eventPlace: 'Las Vegas, NV, USA', isbn: '9781467388511',
      });

      const bookSection = simulateCreateAndRead({
        title: 'Backpropagation Through Time', itemType: 'bookSection', year: 2016,
        bookTitle: 'Deep Learning', publisher: 'MIT Press', place: 'Cambridge, MA',
        edition: '1st', numPages: '800', pages: '367-415',
        series: 'Adaptive Computation and Machine Learning', seriesNumber: '12', isbn: '9780262035613',
        creators: [
          { firstName: 'Ian', lastName: 'Goodfellow', creatorType: 'author' },
          { firstName: 'Yoshua', lastName: 'Bengio', creatorType: 'bookAuthor' },
          { firstName: 'Thomas', lastName: 'Dietterich', creatorType: 'seriesEditor' },
        ],
      }).domain;
      expect(bookSection).toMatchObject({
        bookTitle: 'Deep Learning', publicationTitle: 'Deep Learning', edition: '1st',
        numPages: 800, numberOfPages: 800, seriesNumber: '12',
      });
      expect(bookSection.creators).toEqual(expect.arrayContaining([
        expect.objectContaining({ lastName: 'Goodfellow', creatorType: 'author' }),
        expect.objectContaining({ lastName: 'Bengio', creatorType: 'bookAuthor' }),
        expect.objectContaining({ lastName: 'Dietterich', creatorType: 'seriesEditor' }),
      ]));

      const thesis = simulateCreateAndRead({
        title: 'Representation Learning with Contrastive Predictive Coding', itemType: 'thesis',
        year: 2021, thesisType: 'Ph.D. Dissertation', university: 'University of Oxford',
        place: 'Oxford, UK', numPages: '214',
      }).domain;
      expect(thesis).toMatchObject({
        thesisType: 'Ph.D. Dissertation', university: 'University of Oxford', publisher: 'University of Oxford',
      });

      const report = simulateCreateAndRead({
        title: 'GPT-4 Technical Report', itemType: 'report', year: 2023,
        reportNumber: 'TR-2023-04', reportType: 'Technical Report', institution: 'OpenAI', place: 'San Francisco, CA',
      }).domain;
      expect(report).toMatchObject({
        reportNumber: 'TR-2023-04', reportType: 'Technical Report', institution: 'OpenAI', publisher: 'OpenAI',
      });

      const preprint = simulateCreateAndRead({
        title: 'LLaMA: Open and Efficient Foundation Language Models', itemType: 'preprint',
        year: 2023, repository: 'arXiv', arxivId: '2302.13971', genre: 'Preprint', seriesNumber: 'arXiv:2302.13971',
      }).domain;
      expect(preprint).toMatchObject({ repository: 'arXiv', arxivId: '2302.13971', genre: 'Preprint' });
    });

    it('preserves specialized Zotero item types: patent, computerProgram, dataset, webpage, presentation, case, statute', () => {
      const patent = simulateCreateAndRead({
        title: 'System and Method for Neural Architecture Search', itemType: 'patent', year: 2022,
        patentNumber: 'US11450000B2', applicationNumber: 'US16/987,654',
        issuingAuthority: 'United States Patent and Trademark Office', assignee: 'Google LLC',
        country: 'United States', filingDate: '2020-08-07', issueDate: '2022-09-20',
        priorityNumbers: 'US62/884,123', legalStatus: 'Granted',
        creators: [
          { firstName: 'Barret', lastName: 'Zoph', creatorType: 'inventor' },
          { firstName: 'Quoc V.', lastName: 'Le', creatorType: 'inventor' },
          { name: 'Fish & Richardson P.C.', creatorType: 'attorneyAgent', fieldMode: 1 },
        ],
      }).domain;
      expect(patent).toMatchObject({
        patentNumber: 'US11450000B2', applicationNumber: 'US16/987,654',
        issuingAuthority: 'United States Patent and Trademark Office', assignee: 'Google LLC',
        country: 'United States', filingDate: '2020-08-07', issueDate: '2022-09-20',
        priorityNumbers: 'US62/884,123', legalStatus: 'Granted', authors: ['Barret Zoph', 'Quoc V. Le'],
      });
      expect(patent.creators).toEqual(expect.arrayContaining([
        expect.objectContaining({ lastName: 'Zoph', creatorType: 'inventor' }),
        expect.objectContaining({ fullName: 'Fish & Richardson P.C.', creatorType: 'attorneyAgent', fieldMode: 1 }),
      ]));

      const software = simulateCreateAndRead({
        title: 'PyTorch: An Imperative Style, High-Performance Deep Learning Library',
        itemType: 'computerProgram', year: 2024, versionNumber: '2.5.1',
        system: 'Linux / macOS / Windows (CUDA 12.4)', company: 'Linux Foundation / Meta AI',
        programmingLanguage: 'Python / C++ / CUDA',
        creators: [{ firstName: 'Adam', lastName: 'Paszke', creatorType: 'programmer' }],
      }).domain;
      expect(software).toMatchObject({
        versionNumber: '2.5.1', system: 'Linux / macOS / Windows (CUDA 12.4)',
        company: 'Linux Foundation / Meta AI', publisher: 'Linux Foundation / Meta AI',
        programmingLanguage: 'Python / C++ / CUDA', authors: ['Adam Paszke'],
      });

      const dataset = simulateCreateAndRead({
        title: 'ImageNet Large Scale Visual Recognition Challenge Dataset', itemType: 'dataset',
        year: 2015, versionNumber: 'ILSVRC2012-v1', repository: 'HuggingFace Datasets', doi: '10.5281/zenodo.1234567',
      }).domain;
      expect(dataset).toMatchObject({
        versionNumber: 'ILSVRC2012-v1', repository: 'HuggingFace Datasets', publisher: 'HuggingFace Datasets',
      });

      const webpage = simulateCreateAndRead({
        title: 'The Illustrated Transformer', itemType: 'webpage', year: 2018,
        websiteTitle: 'Jay Alammar Blog', websiteType: 'Technical Blog',
        url: 'https://jalammar.github.io/illustrated-transformer/',
      }).domain;
      expect(webpage).toMatchObject({
        websiteTitle: 'Jay Alammar Blog', publicationTitle: 'Jay Alammar Blog', websiteType: 'Technical Blog',
      });

      const presentation = simulateCreateAndRead({
        title: 'Scaling Laws for Neural Language Models', itemType: 'presentation', year: 2020,
        meetingName: 'ICML 2020 Invited Talk', presentationType: 'Keynote Lecture', eventPlace: 'Vienna, Austria',
        creators: [{ firstName: 'Jared', lastName: 'Kaplan', creatorType: 'presenter' }],
      }).domain;
      expect(presentation).toMatchObject({
        meetingName: 'ICML 2020 Invited Talk', presentationType: 'Keynote Lecture', authors: ['Jared Kaplan'],
      });

      const legalCase = simulateCreateAndRead({
        title: 'Google LLC v. Oracle America, Inc.', itemType: 'case', year: 2021,
        caseName: 'Google LLC v. Oracle America, Inc.', court: 'Supreme Court of the United States',
        docketNumber: '18-956', reporter: 'U.S. Reports', reporterVolume: '593',
        firstPage: '1', dateDecided: '2021-04-05',
        creators: [{ firstName: 'Stephen', lastName: 'Breyer', creatorType: 'author' }],
      }).domain;
      expect(legalCase).toMatchObject({
        caseName: 'Google LLC v. Oracle America, Inc.', court: 'Supreme Court of the United States',
        docketNumber: '18-956', reporter: 'U.S. Reports', reporterVolume: '593', firstPage: '1', dateDecided: '2021-04-05',
      });

      const statute = simulateCreateAndRead({
        title: 'Artificial Intelligence Act', itemType: 'statute', year: 2024,
        nameOfAct: 'Artificial Intelligence Act', code: 'Official Journal of the European Union',
        publicLawNumber: 'Regulation (EU) 2024/1689', dateEnacted: '2024-06-13', session: '2024',
      }).domain;
      expect(statute).toMatchObject({
        nameOfAct: 'Artificial Intelligence Act', code: 'Official Journal of the European Union',
        publicLawNumber: 'Regulation (EU) 2024/1689', dateEnacted: '2024-06-13',
      });
    });
  });

  describe('2. Creator & Contributor Role, FieldMode, and Diacritic Round-Trip Fidelity', () => {
    it('preserves personal two-field vs institutional single-field (fieldMode=1), Vietnamese names, compound surnames, and all creator roles', () => {
      const { row, domain } = simulateCreateAndRead({
        title: 'Global AI Governance and Multilingual NLP in Southeast Asia',
        itemType: 'book',
        year: 2025,
        creators: [
          {
            firstName: 'Quốc Tuấn',
            lastName: 'Nguyễn',
            shortName: 'Nguyễn, Q. T.',
            creatorType: 'author',
            fieldMode: 0,
          },
          { firstName: 'Johannes', lastName: 'van der Waals', creatorType: 'author', fieldMode: 0 },
          { name: 'World Health Organization', creatorType: 'author' },
          { name: 'OpenAI Superalignment Team', creatorType: 'author', fieldMode: 1 },
          { firstName: 'Marie', lastName: 'Skłodowska-Curie', creatorType: 'editor' },
          { firstName: 'Constance', lastName: 'Garnett', creatorType: 'translator' },
        ],
      });

      expect(row.firstAuthor).toBe('Nguyễn et al.');
      expect(domain.creators).toEqual([
        expect.objectContaining({
          firstName: 'Quốc Tuấn',
          lastName: 'Nguyễn',
          fullName: 'Quốc Tuấn Nguyễn',
          shortName: 'Nguyễn, Q. T.',
          creatorType: 'author',
          fieldMode: 0,
          orderIndex: 0,
        }),
        expect.objectContaining({
          firstName: 'Johannes',
          lastName: 'van der Waals',
          fullName: 'Johannes van der Waals',
          creatorType: 'author',
          fieldMode: 0,
          orderIndex: 1,
        }),
        expect.objectContaining({
          lastName: 'World Health Organization',
          fullName: 'World Health Organization',
          creatorType: 'author',
          fieldMode: 1,
          orderIndex: 2,
        }),
        expect.objectContaining({
          lastName: 'OpenAI Superalignment Team',
          fullName: 'OpenAI Superalignment Team',
          creatorType: 'author',
          fieldMode: 1,
          orderIndex: 3,
        }),
        expect.objectContaining({
          firstName: 'Marie',
          lastName: 'Skłodowska-Curie',
          creatorType: 'editor',
          fieldMode: 0,
          orderIndex: 4,
        }),
        expect.objectContaining({
          firstName: 'Constance',
          lastName: 'Garnett',
          creatorType: 'translator',
          fieldMode: 0,
          orderIndex: 5,
        }),
      ]);
      expect(domain.authors).toEqual([
        'Quốc Tuấn Nguyễn',
        'Johannes van der Waals',
        'World Health Organization',
        'OpenAI Superalignment Team',
      ]);
      expect(domain.editors).toEqual(['Marie Skłodowska-Curie']);
    });

    it('supports updating creators via Inspector (reordering, changing roles, adding institutional creators) without losing roles or orderIndex', () => {
      const created = simulateCreateAndRead({
        title: 'Initial Draft Paper',
        itemType: 'journalArticle',
        year: 2024,
        creators: [
          { firstName: 'Alice', lastName: 'Smith', creatorType: 'author' },
          { firstName: 'Bob', lastName: 'Jones', creatorType: 'author' },
        ],
      });

      const updated = simulateUpdateAndRead(created.row, {
        creators: [
          { firstName: 'Bob', lastName: 'Jones', creatorType: 'author' },
          { name: 'CERN ATLAS Collaboration', creatorType: 'author', fieldMode: 1 },
          { firstName: 'Alice', lastName: 'Smith', creatorType: 'editor' },
        ],
      });

      expect(updated.row.firstAuthor).toBe('Jones et al.');
      expect(updated.domain.creators).toEqual([
        expect.objectContaining({
          firstName: 'Bob',
          lastName: 'Jones',
          creatorType: 'author',
          orderIndex: 0,
        }),
        expect.objectContaining({
          lastName: 'CERN ATLAS Collaboration',
          fullName: 'CERN ATLAS Collaboration',
          creatorType: 'author',
          fieldMode: 1,
          orderIndex: 1,
        }),
        expect.objectContaining({
          firstName: 'Alice',
          lastName: 'Smith',
          creatorType: 'editor',
          orderIndex: 2,
        }),
      ]);
      expect(updated.domain.authors).toEqual(['Bob Jones', 'CERN ATLAS Collaboration']);
      expect(updated.domain.editors).toEqual(['Alice Smith']);
    });
  });

  describe('3. Identifier Synchronization, Normalization, and Ghost-Value Prevention', () => {
    it('normalizes dirty DOI/ISBN/ISSN/PMID/PMCID/ArXiv IDs on create and populates canonical ItemIdentifier URIs', () => {
      const norm = normalizeItemIdentifiers({
        doi: 'https://dx.doi.org/10.1038/s41586-021-03819-2.',
        isbn: 'ISBN-13: 978-0-262-03561-3',
        issn: 'ISSN 00280836',
        pmid: 'https://pubmed.ncbi.nlm.nih.gov/34265844/',
        pmcid: 'pmc8372190',
        arxivId: 'https://arxiv.org/abs/2107.03374v2',
      });
      expect(norm).toEqual({
        doi: '10.1038/s41586-021-03819-2',
        isbn: '9780262035613',
        issn: '0028-0836',
        pmid: '34265844',
        pmcid: 'PMC8372190',
        arxivId: '2107.03374v2',
      });

      const { domain } = simulateCreateAndRead({
        title: 'Highly Accurate Protein Structure Prediction with AlphaFold',
        itemType: 'journalArticle',
        year: 2021,
        doi: 'https://dx.doi.org/10.1038/s41586-021-03819-2.',
        issn: 'ISSN 00280836',
        pmid: 'PMID: 34265844',
        pmcid: 'pmc8372190',
        arxivId: 'arXiv:2107.03374v2',
      });

      expect(domain).toMatchObject({
        doi: '10.1038/s41586-021-03819-2',
        issn: '0028-0836',
        pmid: '34265844',
        pmcid: 'PMC8372190',
        arxivId: '2107.03374v2',
      });
      expect(domain.identifiers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'doi',
            value: '10.1038/s41586-021-03819-2',
            canonicalUri: 'https://doi.org/10.1038/s41586-021-03819-2',
          }),
          expect.objectContaining({
            type: 'pmid',
            value: '34265844',
            canonicalUri: 'https://pubmed.ncbi.nlm.nih.gov/34265844/',
          }),
          expect.objectContaining({
            type: 'pmcid',
            value: 'PMC8372190',
            canonicalUri: 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC8372190/',
          }),
          expect.objectContaining({
            type: 'arxiv',
            value: '2107.03374v2',
            canonicalUri: 'https://arxiv.org/abs/2107.03374v2',
          }),
        ]),
      );
    });

    it('completely purges cleared identifiers from Item columns, metadata JSONB, extra text, and ItemIdentifier rows (no ghost resurrection)', () => {
      const created = simulateCreateAndRead({
        title: 'Paper with Erroneous PMID and ArXiv ID',
        itemType: 'journalArticle',
        year: 2024,
        doi: '10.1145/1234567.1234568',
        pmid: '99887766',
        pmcid: 'PMC1122334',
        arxivId: '2401.12345',
        extra: 'PMID: 99887766\nPMCID: PMC1122334\narXiv: 2401.12345\nCustomNote: KeepMe',
      });

      expect(created.domain).toMatchObject({
        pmid: '99887766',
        pmcid: 'PMC1122334',
        arxivId: '2401.12345',
      });

      const updated = simulateUpdateAndRead(created.row, {
        pmid: null,
        pmcid: '',
        arxivId: null,
      });

      expect(updated.row).toMatchObject({ pmid: null, pmcid: null, arxivId: null });
      expect(updated.domain).toMatchObject({
        pmid: '',
        PMID: '',
        pmcid: '',
        PMCID: '',
        arxivId: '',
        doi: '10.1145/1234567.1234568',
      });
      expect(updated.domain.identifiers?.map((i) => i.type)).toEqual(['doi']);
      expect(updated.domain.extra).toContain('CustomNote: KeepMe');
      expect(updated.domain.extra).not.toContain('99887766');
      expect(updated.domain.extra).not.toContain('PMC1122334');
      expect(updated.domain.extra).not.toContain('2401.12345');
    });
  });

  describe('4. Zotero Extra Promotion/Demotion, ItemType Conversion, and Field Locking', () => {
    it('promotes recognized Zotero Extra key-value lines into structured fields and preserves custom lines in extra', () => {
      const { domain } = simulateCreateAndRead({
        title: 'Paper Imported from Zotero RDF with Rich Extra Block',
        itemType: 'journalArticle',
        year: 2023,
        extra: [
          'DOI: 10.1016/j.artint.2023.103999',
          'PMID: 37123456',
          'PMCID: PMC9876543',
          'arXiv: 2305.09876',
          'Original Date: 1995-04',
          'Status: Forthcoming',
          'CustomArchivalCode: ZOT-9981',
        ].join('\n'),
      });

      expect(domain).toMatchObject({
        doi: '10.1016/j.artint.2023.103999',
        pmid: '37123456',
        pmcid: 'PMC9876543',
        arxivId: '2305.09876',
        originalDate: '1995-04',
        status: 'Forthcoming',
      });
      expect(domain.extra).toContain('CustomArchivalCode: ZOT-9981');
    });

    it('gracefully migrates base-mapped and type-specific fields into extra when converting itemType (report -> book)', async () => {
      const created = simulateCreateAndRead({
        title: 'Scaling Instruction-Finetuned Language Models',
        itemType: 'report',
        year: 2022,
        reportNumber: 'FLAN-T5-2022',
        reportType: 'AI Technical Report',
        institution: 'Google Research',
      });

      let currentRow = structuredClone(created.row);
      const typesService = new TypesService();
      const transformer = new ItemTransformer(typesService);
      const conversionService = new ItemTypeConversionService(
        { findById: jest.fn().mockImplementation(async () => currentRow) } as never,
        {
          update: jest.fn().mockImplementation(
            async (_u: string, _id: string, _v: number | undefined, payload: UpdateItemData) => {
              currentRow = simulateUpdateAndRead(currentRow, payload).row;
              return currentRow;
            },
          ),
        } as never,
        typesService,
        transformer,
      );

      const converted = await conversionService.convertItemType(
        TEST_USER_ID,
        currentRow.id,
        'book',
        { retainUnmappedInExtra: true },
      );

      expect(converted.item.itemType).toBe('book');
      expect(converted.item.publisher).toBe('Google Research');
      expect(converted.item.extra).toContain('Report Number: FLAN-T5-2022');
      expect(converted.item.extra).toContain('Report Type: AI Technical Report');
    });

    it('records manual edit provenance and lockedFields when updated by user, and preserves Retraction Watch warnings across updates', () => {
      const created = simulateCreateAndRead({
        title: 'Controversial Room-Temperature Superconductor Paper',
        itemType: 'journalArticle',
        year: 2023,
        doi: '10.1038/s41586-023-05742-0',
        isRetracted: true,
        retractionNature: 'Retraction',
        retractionReason: 'Concerns regarding data integrity and electrical resistance measurements',
        retractionDetails: {
          isRetracted: true,
          nature: 'Retraction',
          reason: 'Concerns regarding data integrity and electrical resistance measurements',
          source: 'Retraction Watch / Crossref',
          retractionDate: '2023-11-07',
        },
      });

      const userEdited = simulateUpdateAndRead(created.row, {
        title: 'Controversial Room-Temperature Superconductor Paper [User Verified Title]',
        volume: '615',
      });

      expect(userEdited.domain).toMatchObject({
        title: 'Controversial Room-Temperature Superconductor Paper [User Verified Title]',
        volume: '615',
        isRetracted: true,
      });
      expect(userEdited.domain.lockedFields).toEqual(expect.arrayContaining(['title', 'volume']));
      expect(userEdited.domain.fieldProvenance?.title).toMatchObject({
        source: 'UserOverride',
        isUserOverride: true,
      });
      expect(userEdited.domain.retractionDetails).toMatchObject({
        isRetracted: true,
        nature: 'Retraction',
      });
    });

    it('preserves full metadata, creators (including fieldMode=1 and shortName), identifiers, and extraFields when cloning Personal -> Project Library via buildImportItemPayload', () => {
      const personal = simulateCreateAndRead({
        title: 'Multimodal Foundation Models in Clinical Decision Support',
        itemType: 'journalArticle',
        year: 2025,
        publicationTitle: 'Nature Medicine',
        journalAbbreviation: 'Nat. Med.',
        volume: '31',
        issue: '4',
        pages: '512-528',
        doi: '10.1038/s41591-025-09999-1',
        pmid: '39876543',
        pmcid: 'PMC10987654',
        arxivId: '2501.05432',
        language: 'en',
        rights: 'CC-BY-4.0',
        creators: [
          { firstName: 'Minh Hoàng', lastName: 'Trần', shortName: 'Trần, M. H.', creatorType: 'author' },
          { name: 'World Health Organization Digital Health Group', creatorType: 'author', fieldMode: 1 },
          { firstName: 'Elena', lastName: 'Rostova', creatorType: 'editor' },
        ],
      });

      const importPayload = buildImportItemPayload(
        personal.row as unknown as ImportSourceItem,
        TEST_USER_ID,
      );
      const projectClone = simulateCreateAndRead(importPayload, TEST_PROJECT_ID);

      expect(projectClone.domain).toMatchObject({
        projectId: TEST_PROJECT_ID,
        title: personal.domain.title,
        publicationTitle: 'Nature Medicine',
        journalAbbreviation: 'Nat. Med.',
        volume: '31',
        issue: '4',
        pages: '512-528',
        doi: '10.1038/s41591-025-09999-1',
        pmid: '39876543',
        pmcid: 'PMC10987654',
        arxivId: '2501.05432',
      });
      expect(projectClone.domain.creators).toEqual([
        expect.objectContaining({
          firstName: 'Minh Hoàng',
          lastName: 'Trần',
          shortName: 'Trần, M. H.',
          creatorType: 'author',
          fieldMode: 0,
        }),
        expect.objectContaining({
          lastName: 'World Health Organization Digital Health Group',
          fullName: 'World Health Organization Digital Health Group',
          creatorType: 'author',
          fieldMode: 1,
        }),
        expect.objectContaining({
          firstName: 'Elena',
          lastName: 'Rostova',
          creatorType: 'editor',
          fieldMode: 0,
        }),
      ]);
    });
  });
});
