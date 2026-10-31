import { TransactionService } from '@/modules/library/sync';
import { CslJsonMapper } from '@/modules/library/citation/domain/csl-json.mapper';
import { CslEngineService } from '@/modules/library/citation/services/csl-engine.service';
import { CitationService } from '@/modules/library/citation/services/citation.service';
import { ExportsService } from '@/modules/library/citation/services/exports.service';
import {
  ExportsRepository,
  ExportItemRecord,
} from '@/modules/library/citation/repositories/exports.repository';
import { PdfBakerService } from '@/modules/library/citation/services/pdf-baker.service';
import {
  buildCommandCreateInput,
  buildCommandUpdateInput,
} from '@/modules/library/catalog/domain/command-payload.builder';
import {
  formatAttachmentFilename,
  extractAuthorTokens,
  extractYearToken,
  sanitizeFilenameStem,
  DEFAULT_RENAME_PATTERN,
} from '@/modules/library/core';
import { AttachmentsService } from '@/modules/library/extraction/services/attachments.service';
import { AttachmentsRepository } from '@/modules/library/extraction/repositories/attachments.repository';
import { QueryRepository } from '@/modules/library/catalog/repositories/query.repository';
import { CommandRepository } from '@/modules/library/catalog/repositories/command.repository';
import { ItemService } from '@/modules/library/catalog/services/items.service';
import { ItemRelationsService } from '@/modules/library/catalog/services/item-relations.service';
import { ItemTypeConversionService } from '@/modules/library/catalog/services/item-type-conversion.service';
import { ItemTransformer } from '@/modules/library/catalog/services/item.transformer';
import { QueryClassifier } from '@/modules/library/ingestion/parsers/bibtex.parser';
import {
  normalizeDoi,
  normalizeArxivId,
  normalizePmid,
  normalizePmcid,
  normalizeIsbn,
  isValidIsbnChecksum,
  convertIsbn10To13,
} from '@/modules/library/core/domain/identifier.domain';
import { BadRequestException } from '@nestjs/common';

describe('Wave 2: Zotero 7 Official Documentation & Power-User User Stories Stress Test', () => {
  // USER STORY 1: Zotero "Extra" Field Cheater Syntax -> CSL & Export Integration
  describe('User Story 1: Zotero "Extra" Field Cheater Syntax (Key: Value & {:Key: Value}) -> CSL & Export Integration', () => {
    let cslEngine: CslEngineService;
    let citationService: CitationService;
    let exportsService: ExportsService;
    let mockExportsRepo: {
      findItems: jest.Mock;
      fetchItemsInChunks: jest.Mock;
      findProjectMember: jest.Mock;
      findCollection: jest.Mock;
      findItemById: jest.Mock;
      findItemsByScope: jest.Mock;
    };

    beforeEach(() => {
      cslEngine = new CslEngineService();
      cslEngine.onModuleInit();
      citationService = new CitationService(undefined, cslEngine);
      mockExportsRepo = {
        findItems: jest.fn(),
        fetchItemsInChunks: jest.fn(),
        findProjectMember: jest.fn(),
        findCollection: jest.fn(),
        findItemById: jest.fn(),
        findItemsByScope: jest.fn(),
      };
      exportsService = new ExportsService(
        mockExportsRepo as unknown as ExportsRepository,
        citationService,
        {} as unknown as PdfBakerService,
      );
    });

    it('parses both Key: Value (with spaces) and braced {:Key: Value} syntax in CslJsonMapper.toCsl', () => {
      const csl = CslJsonMapper.toCsl({
        id: 'item-extra-1',
        itemType: 'book',
        title: 'The Logic of Scientific Discovery',
        year: 2002,
        contributors: [
          {
            firstName: 'Karl',
            lastName: 'Popper',
            creatorType: 'author',
          },
        ],
        extra: [
          'Original Date: 1934',
          'Original Title: Logik der Forschung',
          'Event Place: Vienna, Austria',
          'PMID: 34265844',
          'PMCID: PMC8285168',
          'DOI: https://doi.org/10.4324/9780203994627',
          'Citation Key: popper1934logic',
          '{:status: in press}',
          '{:container-title-short: Logic Sci. Discov.}',
          'Custom archival note preserved for researcher.',
        ].join('\n'),
      });

      expect(csl.id).toBe('popper1934logic');
      expect(csl['citation-key']).toBe('popper1934logic');
      expect(csl['original-date']).toEqual({ 'date-parts': [[1934]] });
      expect(csl['original-title']).toBe('Logik der Forschung');
      expect(csl['event-place']).toBe('Vienna, Austria');
      expect(csl['publisher-place']).toBe('Vienna, Austria');
      expect(csl.PMID).toBe('34265844');
      expect(csl.PMCID).toBe('PMC8285168');
      expect(csl.DOI).toBe('10.4324/9780203994627');
      expect(csl.status).toBe('in press');
      expect(csl['container-title-short']).toBe('Logic Sci. Discov.');
      expect(csl.note).toBe('Custom archival note preserved for researcher.');
    });

    it('overrides CSL item type when Type: dataset or {:type: dataset} is specified in Extra', () => {
      const csl = CslJsonMapper.toCsl({
        id: 'item-dataset-1',
        itemType: 'document',
        title: 'Global Surface Temperature Anomalies 1880-2025',
        year: 2025,
        extra: 'Type: dataset\nPublisher: Zenodo\nVersion: 4.2.0',
      });

      expect(csl.type).toBe('dataset');
      expect(csl.publisher).toBe('Zenodo');
      expect(csl.version).toBe('4.2.0');
    });

    it('extracts pinned BetterBibTeX citation keys (Citation Key:, bibtex:, tex.ids:) and identifiers in CommandPayloadBuilder', async () => {
      const mockPrismaClient = {
        tag: {
          createMany: jest.fn().mockResolvedValue({ count: 0 }),
          findMany: jest.fn().mockResolvedValue([]),
        },
      };

      const { createData } = await buildCommandCreateInput(
        'user-1',
        {
          title: 'Attention Is All You Need',
          itemType: 'conferencePaper',
          year: 2017,
          extra: [
            'Citation Key: vaswani2017attention',
            'arXiv: 1706.03762v5',
            'PMID: 28600001',
            'PMCID: 7654321',
            'DOI: 10.48550/arXiv.1706.03762',
          ].join('\n'),
        },
        mockPrismaClient as unknown as Parameters<
          typeof buildCommandCreateInput
        >[2],
      );

      expect(createData.citationKey).toBe('vaswani2017attention');
      expect(createData.doi).toBe('10.48550/arXiv.1706.03762');
      const meta = createData.metadata as Record<string, unknown>;
      expect(meta.arxivId).toBe('1706.03762v5');
      expect(meta.pmid).toBe('28600001');
      expect(meta.pmcid).toBe('PMC7654321');
    });

    it('exports BibTeX, RIS, CSL-JSON, and CSV with Extra field cheater variables intact', async () => {
      const sampleItems: ExportItemRecord[] = [
        {
          id: 'item-export-extra-1',
          userId: 'user-1',
          projectId: null,
          title: 'Deep Residual Learning for Image Recognition',
          itemType: 'conferencePaper',
          publicationTitle: 'CVPR',
          year: 2016,
          doi: null,
          url: 'https://arxiv.org/abs/1512.03385',
          abstract: 'Residual networks ease training of deep neural networks.',
          citationKey: null,
          updatedAt: new Date('2026-01-15T00:00:00Z'),
          version: 1,
          deletedAt: null,
          contributors: [
            {
              id: 'c-1',
              itemId: 'item-export-extra-1',
              creatorType: 'author',
              fieldMode: 0,
              firstName: 'Kaiming',
              lastName: 'He',
              fullName: 'Kaiming He',
              shortName: '',
              affiliation: null,
              orcid: null,
              orderIndex: 0,
            },
          ],
          attachments: [],
          metadata: {
            extra: [
              'Citation Key: he2016resnet',
              'DOI: 10.1109/CVPR.2016.90',
              'PMID: 27000123',
              'PMCID: PMC5000123',
              'Publisher: IEEE',
              'Event Place: Las Vegas, NV, USA',
              'arXiv: 1512.03385',
            ].join('\n'),
          },
        } as unknown as ExportItemRecord,
      ];

      mockExportsRepo.findItems.mockResolvedValue(sampleItems);

      const bibtexExport = await exportsService.exportLibrary('user-1', {
        format: 'bibtex',
        itemIds: ['item-export-extra-1'],
      });
      expect(bibtexExport.content).toContain('@inproceedings{he2016resnet,');
      expect(bibtexExport.content).toContain('10.1109/CVPR.2016.90');
      expect(bibtexExport.content).toContain('pmid = {27000123}');
      expect(bibtexExport.content).toContain('pmcid = {PMC5000123}');

      const risExport = await exportsService.exportLibrary('user-1', {
        format: 'ris',
        itemIds: ['item-export-extra-1'],
      });
      expect(risExport.content).toContain('DO  - 10.1109/CVPR.2016.90');
      expect(risExport.content).toContain('PB  - IEEE');

      const cslExport = await exportsService.exportLibrary('user-1', {
        format: 'csl-json',
        itemIds: ['item-export-extra-1'],
      });
      const parsedCsl = JSON.parse(cslExport.content);
      expect(parsedCsl[0].id).toBe('he2016resnet');
      expect(parsedCsl[0].DOI).toBe('10.1109/CVPR.2016.90');
      expect(parsedCsl[0]['event-place']).toBe('Las Vegas, NV, USA');

      const csvExport = await exportsService.exportLibrary('user-1', {
        format: 'csv',
        itemIds: ['item-export-extra-1'],
      });
      expect(csvExport.content).toContain('he2016resnet');
      expect(csvExport.content).toContain('10.1109/CVPR.2016.90');
    });
  });

  // USER STORY 2: Zotero 7 Template-Driven File Renaming
  describe('User Story 2: Zotero 7 Template-Driven File Renaming (renamer.domain.ts & AttachmentsService)', () => {
    it('formats Zotero 7 default double-brace template for 1, 2, and 3+ authors', () => {
      const singleAuthor = formatAttachmentFilename(
        DEFAULT_RENAME_PATTERN,
        {
          title:
            'Quantum Supremacy Using a Programmable Superconducting Processor',
          year: 2019,
          contributors: [
            { firstName: 'Frank', lastName: 'Arute', creatorType: 'author' },
          ],
        },
        'raw_scan.pdf',
      );
      expect(singleAuthor).toBe(
        'Arute - 2019 - Quantum Supremacy Using a Programmable Superconducting Processor.pdf',
      );

      const twoAuthors = formatAttachmentFilename(
        '{{ authors suffix=" - " }}{{ year suffix=" - " }}{{ title }}',
        {
          title: 'Mastering the Game of Go without Human Knowledge',
          year: 2017,
          contributors: [
            { firstName: 'David', lastName: 'Silver', creatorType: 'author' },
            {
              firstName: 'Julian',
              lastName: 'Schrittwieser',
              creatorType: 'author',
            },
          ],
        },
        'paper.pdf',
      );
      expect(twoAuthors).toBe(
        'Silver and Schrittwieser - 2017 - Mastering the Game of Go without Human Knowledge.pdf',
      );

      const multiAuthors = formatAttachmentFilename(
        '{{ creators suffix=" - " }}{{ year suffix=" - " }}{{ title }}',
        {
          title: 'Language Models are Few-Shot Learners',
          year: 2020,
          contributors: [
            { firstName: 'Tom', lastName: 'Brown', creatorType: 'author' },
            { firstName: 'Benjamin', lastName: 'Mann', creatorType: 'author' },
            { firstName: 'Nick', lastName: 'Ryder', creatorType: 'author' },
          ],
        },
        'gpt3.pdf',
      );
      expect(multiAuthors).toBe(
        'Brown et al. - 2020 - Language Models are Few-Shot Learners.pdf',
      );
    });

    it('supports single-brace shorthand templates ({author}_{year}_{title}, {citationKey}, {journal})', () => {
      const renamed = formatAttachmentFilename(
        '{author}_{year}_{title}',
        {
          title: 'Deep Learning',
          year: 2015,
          contributors: [
            { firstName: 'Yann', lastName: 'LeCun', creatorType: 'author' },
          ],
        },
        'nature14539.pdf',
      );
      expect(renamed).toBe('LeCun_2015_Deep Learning.pdf');

      const withCiteKeyAndJournal = formatAttachmentFilename(
        '{citationKey} - {journal} - {title}',
        {
          title: 'AlphaFold Protein Structure Database',
          citationKey: 'jumper2021alphafold',
          publicationTitle: 'Nature',
          year: 2021,
        },
        'alphafold.pdf',
      );
      expect(withCiteKeyAndJournal).toBe(
        'jumper2021alphafold - Nature - AlphaFold Protein Structure Database.pdf',
      );
    });

    it('preserves corporate/institutional authors intact and handles Vietnamese/Unicode diacritics', () => {
      const corporate = formatAttachmentFilename(
        DEFAULT_RENAME_PATTERN,
        {
          title: 'WHO Guidelines on Physical Activity and Sedentary Behaviour',
          year: 2020,
          contributors: [
            {
              fieldMode: 1,
              fullName: 'World Health Organization',
              creatorType: 'author',
            },
          ],
        },
        'who_2020.pdf',
      );
      expect(corporate).toBe(
        'World Health Organization - 2020 - WHO Guidelines on Physical Activity and Sedentary Behaviour.pdf',
      );

      const vietnamese = formatAttachmentFilename(
        DEFAULT_RENAME_PATTERN,
        {
          title:
            'Nghiên cứu ứng dụng trí tuệ nhân tạo trong chẩn đoán hình ảnh y khoa',
          year: 2025,
          contributors: [
            {
              firstName: 'Văn An',
              lastName: 'Nguyễn',
              creatorType: 'author',
            },
          ],
        },
        'bai_bao.pdf',
      );
      expect(vietnamese).toBe(
        'Nguyễn - 2025 - Nghiên cứu ứng dụng trí tuệ nhân tạo trong chẩn đoán hình ảnh y khoa.pdf',
      );
    });

    it('gracefully omits missing author or year without leaving dangling separators, sanitizes illegal OS chars, and prevents .pdf.pdf duplication', () => {
      const missingAuthorAndYear = formatAttachmentFilename(
        '{author}_{year}_{title}',
        {
          title:
            'Anonymous Manuscript: A Study of <Ancient/Medieval> Texts? *Draft* | Vol. 1.pdf',
        },
        'scan.pdf',
      );
      expect(missingAuthorAndYear).toBe(
        'Anonymous Manuscript A Study of Ancient Medieval Texts Draft Vol. 1.pdf',
      );
      expect(missingAuthorAndYear).not.toContain('__');
      expect(missingAuthorAndYear).not.toContain('.pdf.pdf');

      const missingYearDefaultPattern = formatAttachmentFilename(
        DEFAULT_RENAME_PATTERN,
        {
          title: 'Working Paper on Distributed Consensus.pdf',
          contributors: [
            { firstName: 'Leslie', lastName: 'Lamport', creatorType: 'author' },
          ],
        },
        'consensus.pdf',
      );
      expect(missingYearDefaultPattern).toBe(
        'Lamport - Working Paper on Distributed Consensus.pdf',
      );
    });

    it('AttachmentsService.renameAttachment & batchRenameAttachments prevent .pdf.pdf duplication and update storage filenames', async () => {
      const mockRepo = {
        findFirst: jest.fn().mockResolvedValue({
          id: 'att-1',
          itemId: 'item-1',
          filename: 'old.pdf',
          fileId: 'file-1',
          item: {
            id: 'item-1',
            title: 'Neural Ordinary Differential Equations.pdf',
            year: 2018,
            contributors: [
              { firstName: 'Ricky', lastName: 'Chen', creatorType: 'author' },
            ],
          },
        }),
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'att-1',
            itemId: 'item-1',
            filename: 'old.pdf',
            fileId: 'file-1',
            item: {
              id: 'item-1',
              title: 'Neural Ordinary Differential Equations',
              year: 2018,
              contributors: [
                { firstName: 'Ricky', lastName: 'Chen', creatorType: 'author' },
              ],
            },
          },
        ]),
        renameAttachment: jest
          .fn()
          .mockImplementation((id, newFilename) =>
            Promise.resolve({ id, filename: newFilename }),
          ),
        batchRename: jest
          .fn()
          .mockImplementation(
            (updates: Array<{ id: string; filename: string }>) =>
              Promise.resolve(updates.length),
          ),
      };
      const mockCatalogGateway = {
        itemExists: jest.fn().mockResolvedValue(true),
        getItem: jest
          .fn()
          .mockResolvedValue({ id: 'item-1', userId: 'user-1' }),
      };

      const service = new AttachmentsService(
        mockRepo as unknown as AttachmentsRepository,
        {} as unknown as TransactionService,
        mockCatalogGateway as unknown as ConstructorParameters<
          typeof AttachmentsService
        >[2],
      );

      const directRename = await service.renameAttachment('user-1', 'att-1', {
        filename: 'Custom_Name_With_Duplicate_Ext.pdf.pdf',
      });
      expect(directRename.newFilename).toBe(
        'Custom_Name_With_Duplicate_Ext.pdf',
      );

      const batchRes = await service.batchRenameAttachments('user-1', {
        attachmentIds: ['att-1'],
        pattern: '{author} ({year}) {title}',
      });
      expect(batchRes.renamedCount).toBe(1);
      expect(batchRes.results[0].newFilename).toBe(
        'Chen (2018) Neural Ordinary Differential Equations.pdf',
      );
    });
  });

  // USER STORY 3: Zotero System Views Lifecycle
  describe('User Story 3: Zotero System Views Lifecycle (Unfiled Items, My Publications, Recently Read, Trash & Restore/Purge)', () => {
    it('QueryRepository.buildWhereClause constructs accurate Prisma filters for unfiled, my-publications, recent, starred, and trash views', () => {
      const mockPrisma = {};
      const queryRepo = new QueryRepository(
        mockPrisma as unknown as ConstructorParameters<
          typeof QueryRepository
        >[0],
      );

      const unfiledWhere = queryRepo.buildWhereClause('user-1', {
        view: 'unfiled',
      });
      expect(unfiledWhere.deletedAt).toBeNull();
      expect(unfiledWhere.collectionItems).toEqual({ none: {} });

      const myPubsWhere = queryRepo.buildWhereClause('user-1', {
        view: 'my-publications',
      });
      expect(myPubsWhere.deletedAt).toBeNull();
      expect(myPubsWhere.AND).toEqual([
        {
          OR: [
            {
              metadata: {
                path: ['isMyPublication'],
                equals: true,
              },
            },
            {
              publications: {
                some: { userId: 'user-1' },
              },
            },
          ],
        },
      ]);

      const starredWhere = queryRepo.buildWhereClause('user-1', {
        view: 'starred',
      });
      expect(starredWhere.deletedAt).toBeNull();
      expect(starredWhere.states).toEqual({
        some: {
          userId: 'user-1',
          isStarred: true,
        },
      });

      const trashWhere = queryRepo.buildWhereClause('user-1', {
        view: 'trash',
      });
      expect(trashWhere.deletedAt).toEqual({ not: null });
    });

    it('ItemService executes bulkTrash -> bulkRestore -> bulkPurge lifecycle cleanly', async () => {
      const mockQueryRepo = {
        findById: jest.fn().mockResolvedValue({ id: 'item-1', title: 'Test' }),
        findByIds: jest
          .fn()
          .mockImplementation(async (_u, ids) =>
            ids.map((id: string) => ({ id, title: `Test ${id}`, version: 3 })),
          ),
      };
      const mockCommandRepo = {
        softDelete: jest.fn().mockResolvedValue({
          id: 'item-1',
          version: 2,
          deletedAt: new Date(),
        }),
        softDeleteMany: jest.fn().mockImplementation(async (_u, itemIds) => ({
          succeededIds: itemIds,
          failedIds: [],
        })),
        delete: jest.fn().mockResolvedValue({ id: 'item-1', version: 2 }),
        restore: jest.fn().mockResolvedValue({
          id: 'item-1',
          title: 'Test',
          itemType: 'journalArticle',
          version: 3,
          metadata: {},
        }),
        restoreMany: jest.fn().mockImplementation(async (_u, itemIds) => ({
          succeededIds: itemIds,
          failedIds: [],
          restoredItems: itemIds.map((id: string) => ({
            id,
            version: 3,
            projectId: null,
          })),
        })),
        purge: jest.fn().mockResolvedValue(true),
        purgeMany: jest.fn().mockImplementation(async (_u, itemIds) => ({
          succeededIds: itemIds,
          failedIds: [],
          fileIdsToDelete: [],
          storagePaths: [],
        })),
      };
      const mockLibraryTx = {
        executeInTransaction: jest.fn().mockImplementation(async (fn) =>
          fn(
            {},
            {
              appendChange: jest.fn().mockResolvedValue(undefined),
              appendChangesBatch: jest.fn().mockResolvedValue(2),
              publishOutbox: jest.fn().mockResolvedValue(undefined),
              publishOutboxBatch: jest.fn().mockResolvedValue(['ev-1', 'ev-2']),
              recordTombstone: jest.fn().mockResolvedValue(undefined),
              recordTombstonesBatch: jest.fn().mockResolvedValue(2),
              removeTombstone: jest.fn().mockResolvedValue(1),
              removeTombstonesBatch: jest.fn().mockResolvedValue(2),
            },
          ),
        ),
      };
      const mockTagsService = {
        invalidateTagsCache: jest.fn().mockResolvedValue(undefined),
      };

      const itemService = new ItemService(
        mockQueryRepo as unknown as QueryRepository,
        mockCommandRepo as unknown as CommandRepository,
        mockLibraryTx as unknown as TransactionService,
        mockTagsService as unknown as ConstructorParameters<
          typeof ItemService
        >[3],
      );

      const trashRes = await itemService.bulkTrash('user-1', [
        'item-1',
        'item-2',
      ]);
      expect(trashRes.trashedCount).toBe(2);
      expect(trashRes.succeededIds).toEqual(['item-1', 'item-2']);

      const restoreRes = await itemService.bulkRestore('user-1', [
        'item-1',
        'item-2',
      ]);
      expect(restoreRes.restoredCount).toBe(2);
      expect(restoreRes.succeededIds).toEqual(['item-1', 'item-2']);

      const purgeRes = await itemService.bulkPurge('user-1', [
        'item-1',
        'item-2',
      ]);
      expect(purgeRes.purgedCount).toBe(2);
      expect(purgeRes.succeededIds).toEqual(['item-1', 'item-2']);
      expect(mockCommandRepo.purgeMany).toHaveBeenCalledTimes(1);
    });
  });

  // USER STORY 4: Zotero Item Type Switching Across Diverse Academic Taxonomy
  describe('User Story 4: Zotero Item Type Switching (ItemTypeConversionService & ItemTransformer)', () => {
    let transformer: ItemTransformer;

    beforeEach(() => {
      const { TypesService } = jest.requireActual(
        '../../../src/modules/library/catalog/services/types.service',
      );
      transformer = new ItemTransformer(new TypesService());
    });

    it('maps conferencePaper -> journalArticle (proceedingsTitle -> publicationTitle) and preserves unmapped fields in Extra', () => {
      const preview = transformer.previewConversion(
        {
          id: 'item-conf-1',
          itemType: 'conferencePaper',
          title: 'Attention Is All You Need',
          proceedingsTitle: 'Advances in Neural Information Processing Systems',
          conferenceName: 'NeurIPS 2017',
          place: 'Long Beach, CA',
          year: 2017,
          pages: '5998-6008',
          contributors: [
            {
              creatorType: 'author',
              firstName: 'Ashish',
              lastName: 'Vaswani',
            },
          ],
        },
        'journalArticle',
        { retainUnmappedInExtra: true },
      );

      expect(preview.targetType).toBe('journalArticle');
      expect(preview.projectedItem.publicationTitle).toBe(
        'Advances in Neural Information Processing Systems',
      );
      expect(preview.mappedFields).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            fromField: 'proceedingsTitle',
            toField: 'publicationTitle',
          }),
        ]),
      );
      expect(preview.projectedItem.extra).toContain(
        'Conference Name: NeurIPS 2017',
      );
    });

    it('maps bookSection -> book (bookTitle -> title, original chapter title retained as Section Title in Extra)', () => {
      const preview = transformer.previewConversion(
        {
          id: 'item-chap-1',
          itemType: 'bookSection',
          title: 'Chapter 4: Backpropagation and Gradient Descent',
          bookTitle: 'Deep Learning Foundations',
          publisher: 'MIT Press',
          year: 2016,
          pages: '110-145',
          contributors: [
            { creatorType: 'author', firstName: 'Ian', lastName: 'Goodfellow' },
            {
              creatorType: 'bookAuthor',
              firstName: 'Yoshua',
              lastName: 'Bengio',
            },
          ],
        },
        'book',
        { retainUnmappedInExtra: true },
      );

      expect(preview.projectedItem.title).toBe('Deep Learning Foundations');
      expect(preview.projectedItem.extra).toContain(
        'Section Title: Chapter 4: Backpropagation and Gradient Descent',
      );
      expect(preview.creatorChanges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            fromRole: 'bookAuthor',
            toRole: 'contributor',
            reason: 'secondary-fallback',
          }),
        ]),
      );
    });

    it('converts journalArticle -> book -> journalArticle without polluting Extra with internal __unmapped_ keys', () => {
      const toBook = transformer.previewConversion(
        {
          id: 'item-ja-1',
          itemType: 'journalArticle',
          title: 'A Mathematical Theory of Communication',
          publicationTitle: 'Bell System Technical Journal',
          volume: '27',
          issue: '3',
          pages: '379-423',
          year: 1948,
        },
        'book',
        { retainUnmappedInExtra: true },
      );

      expect(String(toBook.projectedItem.extra || '')).toContain('Issue: 3');
      expect(String(toBook.projectedItem.extra || '')).not.toContain(
        '__unmapped_',
      );

      // Verify buildCommandUpdateInput does not leak __unmapped_ keys into metadata.extra
      const { updateData } = buildCommandUpdateInput(
        'user-1',
        {
          id: 'item-ja-1',
          title: 'A Mathematical Theory of Communication',
          itemType: 'journalArticle',
          metadata: {},
        },
        {
          itemType: 'book',
          extra: toBook.projectedItem.extra as string | undefined,
          extraFields: toBook.projectedItem.extraFields as
            Record<string, unknown> | undefined,
        },
      );
      const updatedMeta = updateData.metadata as Record<string, unknown>;
      expect(String(updatedMeta.extra || '')).not.toContain('__unmapped_');
      expect(String(updatedMeta.extra || '')).toContain('Issue: 3');
    });
  });

  // USER STORY 5: Bidirectional Related Items & Citation Graph
  describe('User Story 5: Bidirectional Related Items & Citation Graph', () => {
    it('prevents self-relations, maps reciprocal semantic relation types, and filters out soft-deleted peers', async () => {
      const userId = '00000000-0000-4000-8000-000000000001';
      const itemAId = '00000000-0000-4000-8000-00000000000a';
      const itemBId = '00000000-0000-4000-8000-00000000000b';
      const itemTrashedId = '00000000-0000-4000-8000-00000000000c';

      const storedRelations: Array<{
        id: string;
        sourceItemId: string;
        targetItemId: string;
        relationType: string;
        createdAt: Date;
      }> = [];

      const itemsDb: Record<
        string,
        {
          id: string;
          userId: string;
          title: string;
          itemType: string;
          year: number;
          doi: string | null;
          deletedAt: Date | null;
          metadata: Record<string, unknown>;
        }
      > = {
        [itemAId]: {
          id: itemAId,
          userId,
          title: 'Preprint Version (arXiv)',
          itemType: 'preprint',
          year: 2024,
          doi: null,
          deletedAt: null,
          metadata: {},
        },
        [itemBId]: {
          id: itemBId,
          userId,
          title: 'Published Journal Version',
          itemType: 'journalArticle',
          year: 2025,
          doi: '10.1038/s41586-025-00001-1',
          deletedAt: null,
          metadata: {},
        },
        [itemTrashedId]: {
          id: itemTrashedId,
          userId,
          title: 'Trashed Paper',
          itemType: 'journalArticle',
          year: 2020,
          doi: null,
          deletedAt: new Date(),
          metadata: {},
        },
      };

      const mockPrisma = {
        item: {
          findUnique: jest
            .fn()
            .mockImplementation(({ where }) =>
              Promise.resolve(itemsDb[where.id] || null),
            ),
        },
        itemRelation: {
          findMany: jest.fn().mockImplementation(({ where }) => {
            const orConds = Array.isArray(where?.OR) ? where.OR : [where];
            return Promise.resolve(
              storedRelations
                .filter((rel) => {
                  return orConds.some((cond: Record<string, unknown>) => {
                    if (cond.sourceItemId === rel.sourceItemId) {
                      const target = itemsDb[rel.targetItemId];
                      return Boolean(target && target.deletedAt === null);
                    }
                    if (cond.targetItemId === rel.targetItemId) {
                      const source = itemsDb[rel.sourceItemId];
                      return Boolean(source && source.deletedAt === null);
                    }
                    return false;
                  });
                })
                .map((rel) => ({
                  ...rel,
                  targetItem: itemsDb[rel.targetItemId],
                  sourceItem: itemsDb[rel.sourceItemId],
                })),
            );
          }),
          upsert: jest.fn().mockImplementation(({ create }) => {
            const existing = storedRelations.find(
              (r) =>
                r.sourceItemId === create.sourceItemId &&
                r.targetItemId === create.targetItemId &&
                r.relationType === create.relationType,
            );
            if (!existing) {
              storedRelations.push({
                id: `rel-${storedRelations.length + 1}`,
                ...create,
                createdAt: new Date(),
              });
            }
            return Promise.resolve(
              existing || storedRelations[storedRelations.length - 1],
            );
          }),
          deleteMany: jest.fn().mockImplementation(() => {
            const before = storedRelations.length;
            for (let i = storedRelations.length - 1; i >= 0; i--) {
              const r = storedRelations[i];
              const matchPair =
                (r.sourceItemId === itemAId && r.targetItemId === itemBId) ||
                (r.sourceItemId === itemBId && r.targetItemId === itemAId);
              if (matchPair) {
                storedRelations.splice(i, 1);
              }
            }
            return Promise.resolve({ count: before - storedRelations.length });
          }),
        },
      };

      const queryRepo = new QueryRepository(
        mockPrisma as unknown as ConstructorParameters<
          typeof QueryRepository
        >[0],
      );
      jest
        .spyOn(queryRepo, 'findById')
        .mockImplementation((_u, id) =>
          Promise.resolve(
            itemsDb[id] && !itemsDb[id].deletedAt
              ? (itemsDb[id] as unknown as Awaited<
                  ReturnType<typeof queryRepo.findById>
                >)
              : null,
          ),
        );
      jest
        .spyOn(queryRepo, 'findByIds')
        .mockImplementation((_u, ids) =>
          Promise.resolve(
            ids
              .map((id) => itemsDb[id])
              .filter((it) => it && !it.deletedAt) as unknown as Awaited<
              ReturnType<typeof queryRepo.findByIds>
            >,
          ),
        );

      const commandRepo = new CommandRepository(
        mockPrisma as unknown as ConstructorParameters<
          typeof CommandRepository
        >[0],
      );

      const relationsService = new ItemRelationsService(queryRepo, commandRepo);

      // 1. Self-relation must be rejected
      await expect(
        relationsService.linkItems(userId, itemAId, {
          targetItemIds: [itemAId],
          relationType: 'related',
        }),
      ).rejects.toThrow(BadRequestException);

      // 2. Link item-a -> item-b as is_preprint_of (and link to trashed item which is ignored)
      await relationsService.linkItems(userId, itemAId, {
        targetItemIds: [itemBId, itemTrashedId],
        relationType: 'is_preprint_of',
      });

      // Duplicate link should be idempotent
      const linkResult = await relationsService.linkItems(userId, itemAId, {
        targetItemIds: [itemBId],
        relationType: 'is_preprint_of',
      });
      expect(linkResult.totalLinked).toBe(1);

      const fromA = await relationsService.getRelatedItems(userId, itemAId);
      expect(fromA.relatedItems).toHaveLength(1);
      expect(fromA.relatedItems[0]).toMatchObject({
        targetItemId: itemBId,
        relationType: 'is_preprint_of',
        direction: 'outgoing',
      });

      // 3. Reciprocal visibility from item-b shows `is_published_version_of`
      const fromB = await relationsService.getRelatedItems(userId, itemBId);
      expect(fromB.relatedItems).toHaveLength(1);
      expect(fromB.relatedItems[0]).toMatchObject({
        targetItemId: itemAId,
        relationType: 'is_published_version_of',
        direction: 'incoming',
      });

      // 4. Unlinking from item-b removes the bidirectional relation
      const unlinkRes = await relationsService.unlinkItems(
        userId,
        itemBId,
        itemAId,
      );
      expect(unlinkRes.unlinked).toBe(true);
      const afterUnlink = await relationsService.getRelatedItems(
        userId,
        itemBId,
      );
      expect(afterUnlink.relatedItems).toHaveLength(0);
    });
  });

  // USER STORY 6: Standalone PDF Drop & "Add Item by Identifier" Lookup
  describe('User Story 6: Identifier Lookup (Add Item by Identifier) & Trailing Punctuation Sanitization', () => {
    it('strips trailing sentence punctuation and surrounding parentheses/brackets across DOI, ISBN, PMID, PMCID, and arXiv IDs', () => {
      // DOIs copied from bibliography sentences
      expect(normalizeDoi('(https://doi.org/10.1038/nature14539).')).toBe(
        '10.1038/nature14539',
      );
      expect(
        normalizeDoi(
          '10.1002/(SICI)1097-0258(19980815/30)17:15/16<1661::AID-SIM870>3.0.CO;2-2.',
        ),
      ).toBe(
        '10.1002/(sici)1097-0258(19980815/30)17:15/16<1661::aid-sim870>3.0.co;2-2',
      );

      // arXiv IDs with version and trailing punctuation or arXiv DOIs
      expect(normalizeArxivId('(arXiv:2305.18290v2 [cs.CL]).')).toBe(
        '2305.18290v2',
      );
      expect(
        normalizeArxivId('https://doi.org/10.48550/arXiv.2305.18290v2,', {
          stripVersion: true,
        }),
      ).toBe('2305.18290');

      // PMID & PMCID with trailing punctuation
      expect(normalizePmid('(PMID: 34265844).')).toBe('34265844');
      expect(normalizePmcid('[PMCID: PMC8285168];')).toBe('PMC8285168');

      // ISBN-10 and ISBN-13 normalization, checksum validation, and ISBN-10 -> ISBN-13 conversion
      expect(normalizeIsbn('(ISBN: 978-0-262-03561-3).')).toBe('9780262035613');
      expect(normalizeIsbn('ISBN-10: 0-262-03384-4;')).toBe('0262033844');
      expect(isValidIsbnChecksum('978-0-262-03561-3')).toBe(true);
      expect(isValidIsbnChecksum('0-262-03384-4')).toBe(true);
      expect(isValidIsbnChecksum('0-306-40615-2')).toBe(true);
      expect(isValidIsbnChecksum('0-306-40615-3')).toBe(false);
      expect(
        normalizeIsbn('0-306-40615-2', {
          strictChecksum: true,
          toIsbn13: true,
        }),
      ).toBe('9780306406157');
      expect(convertIsbn10To13('0-306-40615-2')).toBe('9780306406157');
    });

    it('QueryClassifier.classify and classifyBatch accurately classify noisy and multi-identifier inputs', () => {
      expect(QueryClassifier.classify('(10.1038/nature14539).')).toEqual({
        raw: '(10.1038/nature14539).',
        clean: '10.1038/nature14539',
        type: 'DOI',
      });

      expect(QueryClassifier.classify('[arXiv:2305.18290v2];')).toEqual({
        raw: '[arXiv:2305.18290v2];',
        clean: '2305.18290v2',
        type: 'ARXIV',
      });

      expect(
        QueryClassifier.classify(
          'https://doi.org/10.48550/arXiv.1706.03762v5.',
        ),
      ).toEqual({
        raw: 'https://doi.org/10.48550/arXiv.1706.03762v5.',
        clean: '1706.03762v5',
        type: 'ARXIV',
      });

      expect(QueryClassifier.classify('(ISBN 978-0-262-03561-3),')).toEqual({
        raw: '(ISBN 978-0-262-03561-3),',
        clean: '9780262035613',
        type: 'ISBN',
      });

      const batch = QueryClassifier.classifyBatch(
        '10.1038/nature14539, arXiv:1706.03762v5; PMID:34265844\n978-0-262-03561-3',
      );
      expect(batch.map((b) => ({ type: b.type, clean: b.clean }))).toEqual([
        { type: 'DOI', clean: '10.1038/nature14539' },
        { type: 'ARXIV', clean: '1706.03762v5' },
        { type: 'PMID', clean: '34265844' },
        { type: 'ISBN', clean: '9780262035613' },
      ]);
    });
  });
});
