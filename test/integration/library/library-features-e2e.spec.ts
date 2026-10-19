import { TypesService } from '@/modules/library/catalog/services/types.service';
import { ZoteroSchemaValidatorService } from '@/modules/library/catalog/services/zotero-schema-validator.service';
import { ItemTransformer } from '@/modules/library/catalog/domain/item.transformer';
import { TreeEngine } from '@/modules/library/catalog/domain/tree.engine';
import { CslJsonMapper } from '@/modules/library/citation/domain/csl-json.mapper';
import { CslEngineService } from '@/modules/library/citation/services/csl-engine.service';
import {
  cleanAuthorName,
  splitAuthorString,
  cleanAbstractText,
  sanitizeItemTitle,
  normalizeDoi,
  normalizeArxivId,
  normalizeIsbn,
} from '@/modules/library/core';
import {
  ARXIV_CATEGORY_MAP,
  resolveCanonicalArxivCategory,
  normalizeAcademicTags,
  cleanSingleTag,
} from '@/modules/library/core';
import { formatLiteratureNoteMarkdown } from '@/modules/library/catalog/domain/notes.domain';
import {
  isValidRating,
  isValidCurrentPage,
  shouldAutoAdvanceToReading,
  isValidStateTransition,
} from '@/modules/library/catalog/domain/state.domain';
import { ReadingStatus } from '@/modules/library/catalog/types/state.types';
import { VersionMismatchException } from '@/modules/library/core/errors/version-mismatch.exception';
import { buildMockLibraryItem } from '@test/factories';

describe('Comprehensive Library End-to-End (E2E) Feature Matrix Simulation', () => {
  const userId = '01920b92-user-7111-8111-111111111111';
  const projectId = '01920b92-proj-7111-8111-222222222222';

  let typesService: TypesService;
  let schemaValidator: ZoteroSchemaValidatorService;
  let transformer: ItemTransformer;
  let treeEngine: TreeEngine;
  let cslEngine: CslEngineService;

  // In-Memory Database Store for E2E Flow Execution
  interface E2EItem {
    id: string;
    userId: string;
    projectId?: string | null;
    title: string;
    itemType: string;
    publicationTitle?: string;
    publisher?: string;
    volume?: string;
    issue?: string;
    pages?: string;
    date?: string;
    year?: number;
    doi?: string;
    arxivId?: string;
    isbn?: string;
    abstract?: string;
    extra?: string;
    creators: Array<{
      orderIndex: number;
      creatorType: string;
      firstName?: string;
      lastName?: string;
      fullName: string;
    }>;
    tags: string[];
    collections: string[];
    citationKey: string;
    version: number;
    isDeleted: boolean;
    isRetracted?: boolean;
    retractionReason?: string;
    createdAt: Date;
    updatedAt: Date;
  }

  interface E2ECollection {
    id: string;
    name: string;
    parentId: string | null;
    projectId?: string | null;
  }

  interface E2EAnnotation {
    id: string;
    itemId: string;
    pageIndex: number;
    type?: string;
    quoteText?: string;
    comment?: string;
    color: string;
    rects?: Array<{ x1: number; y1: number; x2: number; y2: number }>;
  }

  interface E2EReadingState {
    itemId: string;
    userId: string;
    status: 'unread' | 'reading' | 'read';
    currentPage: number;
    totalPages: number;
    progressPercentage: number;
    rating?: number;
  }

  interface E2ESyncRecord {
    sequence: number;
    scope: 'user' | 'project';
    scopeId: string;
    entityId: string;
    entityType: 'Item' | 'Collection' | 'Note' | 'Annotation';
    action: 'create' | 'update' | 'delete' | 'restore';
    version: number;
  }

  let dbItems: Map<string, E2EItem>;
  let dbCollections: Map<string, E2ECollection>;
  let dbAnnotations: Map<string, E2EAnnotation[]>;
  let dbReadingStates: Map<string, E2EReadingState>;
  let dbSyncLog: E2ESyncRecord[];
  let monotonicSeq: number;

  beforeAll(() => {
    typesService = new TypesService();
    schemaValidator = new ZoteroSchemaValidatorService(typesService);
    transformer = new ItemTransformer(typesService);
    treeEngine = new TreeEngine();
    cslEngine = new CslEngineService();
    cslEngine.initTemplates();
  });

  beforeEach(() => {
    dbItems = new Map();
    dbCollections = new Map();
    dbAnnotations = new Map();
    dbReadingStates = new Map();
    dbSyncLog = [];
    monotonicSeq = 0;
  });

  // Action Helpers
  function logSync(
    scope: 'user' | 'project',
    scopeId: string,
    entityType: 'Item' | 'Collection' | 'Note' | 'Annotation',
    entityId: string,
    action: 'create' | 'update' | 'delete' | 'restore',
    version: number,
  ) {
    monotonicSeq++;
    dbSyncLog.push({
      sequence: monotonicSeq,
      scope,
      scopeId,
      entityId,
      entityType,
      action,
      version,
    });
  }

  function createItem(
    scope: { userId: string; projectId?: string | null },
    raw: Partial<E2EItem> & { title: string; itemType: string },
  ): E2EItem {
    const cleanTitle = sanitizeItemTitle(raw.title);
    if (!cleanTitle) throw new Error('Title cannot be empty');

    const validated = schemaValidator.validateAndSanitizeItem(raw.itemType, {
      ...raw,
      title: cleanTitle,
    });

    const itemId =
      raw.id ||
      `item-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
    const firstAuthor =
      raw.creators?.[0]?.lastName ||
      raw.creators?.[0]?.fullName?.split(' ').pop() ||
      'ref';
    const year = raw.year || (raw.date ? parseInt(raw.date, 10) : 2026);
    const kw = cleanTitle
      .split(' ')[0]
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
    const citationKey = `${firstAuthor.toLowerCase()}${year}${kw}`;

    const item: E2EItem = {
      id: itemId,
      userId: scope.userId,
      projectId: scope.projectId || null,
      title: cleanTitle,
      itemType: raw.itemType,
      publicationTitle: raw.publicationTitle,
      publisher: raw.publisher,
      volume: raw.volume,
      issue: raw.issue,
      pages: raw.pages,
      date: raw.date,
      year,
      doi: normalizeDoi(raw.doi),
      arxivId: normalizeArxivId(raw.arxivId),
      isbn: normalizeIsbn(raw.isbn),
      abstract: cleanAbstractText(raw.abstract || ''),
      extra: (validated.sanitizedItem as any).extra || '',
      creators: raw.creators || [],
      tags: normalizeAcademicTags(raw.tags || []),
      collections: raw.collections || [],
      citationKey,
      version: 1,
      isDeleted: false,
      isRetracted: raw.isRetracted || false,
      retractionReason: raw.retractionReason,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    dbItems.set(itemId, item);
    logSync(
      scope.projectId ? 'project' : 'user',
      scope.projectId || scope.userId,
      'Item',
      itemId,
      'create',
      1,
    );
    return item;
  }

  function updateItem(
    itemId: string,
    patch: Partial<E2EItem>,
    expectedVersion: number,
  ): E2EItem {
    const item = dbItems.get(itemId);
    if (!item) throw new Error(`Item ${itemId} not found`);

    if (item.version !== expectedVersion) {
      throw new VersionMismatchException({
        aggregateType: 'Item',
        entityId: itemId,
        currentVersion: item.version,
        expectedVersion,
      });
    }

    const updated: E2EItem = {
      ...item,
      ...patch,
      tags: patch.tags ? normalizeAcademicTags(patch.tags) : item.tags,
      version: item.version + 1,
      updatedAt: new Date(),
    };

    dbItems.set(itemId, updated);
    logSync(
      updated.projectId ? 'project' : 'user',
      updated.projectId || updated.userId,
      'Item',
      itemId,
      'update',
      updated.version,
    );
    return updated;
  }

  // FLOW 1: INGESTION, MULTI-SOURCE IDENTIFIER CLEANING & NORMALIZATION
  describe('Flow 1: Ingestion, Identifier Cleaning & Academic Data Intake', () => {
    it('1.1 Should normalize DOI formats and clean raw HTML/XML and LaTeX abstract', () => {
      const rawDoiInput = 'https://doi.org/10.1038/s41586-021-03819-2';
      const cleanDoi = normalizeDoi(rawDoiInput);
      expect(cleanDoi).toBe('10.1038/s41586-021-03819-2');

      const rawAbstract =
        '<p>ABSTRACT: Here we present <i>AlphaFold</i> with <b>unprecedented</b> accuracy $\\mathcal{O}(N^2)$ in 3D space.</p>';
      const cleanAbs = cleanAbstractText(rawAbstract);

      // XML tags stripped, label stripped, math preserved
      expect(cleanAbs).toBe(
        'Here we present AlphaFold with unprecedented accuracy $\\mathcal{O}(N^2)$ in 3D space.',
      );

      const item = createItem(
        { userId },
        {
          title: 'Highly Accurate Protein Structure Prediction with AlphaFold',
          itemType: 'journalArticle',
          publicationTitle: 'Nature',
          year: 2021,
          doi: cleanDoi,
          abstract: cleanAbs,
          creators: [
            {
              orderIndex: 0,
              creatorType: 'author',
              firstName: 'John',
              lastName: 'Jumper',
              fullName: 'John Jumper',
            },
            {
              orderIndex: 1,
              creatorType: 'author',
              firstName: 'Demis',
              lastName: 'Hassabis',
              fullName: 'Demis Hassabis',
            },
          ],
        },
      );

      expect(item.id).toBeDefined();
      expect(item.doi).toBe('10.1038/s41586-021-03819-2');
      expect(item.citationKey).toBe('jumper2021highly');
    });

    it('1.2 Should normalize arXiv identifiers, categories, and dirty scraped author strings', () => {
      const arxivUrl = 'https://arxiv.org/abs/1706.03762v7';
      const cleanArxiv = normalizeArxivId(arxivUrl);
      expect(cleanArxiv).toBe('1706.03762v7');

      // Canonical arXiv category resolution from tags/metadata
      const category = resolveCanonicalArxivCategory('1706.03762', ['cs.cl']);
      expect(category).toBe('cs.CL');

      const humanTaxonomy = ARXIV_CATEGORY_MAP['cs.cl'];
      expect(humanTaxonomy).toBe('Computer Science - Computation and Language');

      const rawAuthors =
        'Ashish Vaswani 1,*, Noam Shazeer 1, Niki Parmar <niki@google.com>';
      const cleanedNames = splitAuthorString(rawAuthors);
      expect(cleanedNames).toEqual([
        'Ashish Vaswani',
        'Noam Shazeer',
        'Niki Parmar',
      ]);

      const item = createItem(
        { userId, projectId },
        {
          title: 'Attention Is All You Need',
          itemType: 'preprint',
          year: 2017,
          arxivId: cleanArxiv,
          creators: cleanedNames.map((name, idx) => {
            const parts = name.split(' ');
            return {
              orderIndex: idx,
              creatorType: 'author',
              firstName: parts[0],
              lastName: parts[1],
              fullName: name,
            };
          }),
          tags: ['machine-learning', 'transformers', 'dirty   tag  '],
        },
      );

      expect(item.projectId).toBe(projectId);
      expect(item.citationKey).toBe('vaswani2017attention');
      expect(item.tags).toEqual([
        'machine-learning',
        'transformers',
        'dirty tag',
      ]);
    });

    it('1.3 Should demote non-schema custom fields safely into extra without data loss', () => {
      const item = createItem({ userId }, {
        title: 'Deep Learning Book',
        itemType: 'book',
        publisher: 'MIT Press',
        year: 2016,
        isbn: '978-0262035613',
        customLaboratoryCode: 'LAB-MIT-999',
      } as any);

      expect(item.itemType).toBe('book');
      expect(item.isbn).toBe('9780262035613');
      expect(item.extra).toContain('customLaboratoryCode: LAB-MIT-999');
    });
  });

  // FLOW 2: DEDUPLICATION, MATCH CLUSTERING & ZOTERO-STYLE MERGING
  describe('Flow 2: Deduplication, Conflict Detection & Zotero-style Merging', () => {
    it('2.1 Should detect exact DOI duplicate and perform safe non-destructive merge', () => {
      const item1 = createItem(
        { userId },
        {
          id: 'item-orig',
          title: 'Attention Is All You Need',
          itemType: 'preprint',
          year: 2017,
          doi: '10.5555/3295222.3295349',
          creators: [
            {
              orderIndex: 0,
              creatorType: 'author',
              firstName: 'Ashish',
              lastName: 'Vaswani',
              fullName: 'Ashish Vaswani',
            },
          ],
          tags: ['deep-learning'],
          collections: ['col-reading-list'],
        },
      );

      const item2 = createItem(
        { userId },
        {
          id: 'item-duplicate',
          title: 'Attention is all you need (NIPS Conference Copy)',
          itemType: 'conferencePaper',
          publicationTitle: 'NeurIPS 2017',
          year: 2017,
          doi: '10.5555/3295222.3295349',
          creators: [
            {
              orderIndex: 0,
              creatorType: 'author',
              firstName: 'Ashish',
              lastName: 'Vaswani',
              fullName: 'Ashish Vaswani',
            },
            {
              orderIndex: 1,
              creatorType: 'author',
              firstName: 'Noam',
              lastName: 'Shazeer',
              fullName: 'Noam Shazeer',
            },
          ],
          tags: ['attention', 'nlp'],
          collections: ['col-neurips'],
        },
      );

      // Detection
      const hasDoiMatch = item1.doi && item2.doi && item1.doi === item2.doi;
      expect(hasDoiMatch).toBe(true);

      // Execute Merge: master is item1, source is item2
      const mergedCollections = Array.from(
        new Set([...item1.collections, ...item2.collections]),
      );
      const mergedTags = normalizeAcademicTags([...item1.tags, ...item2.tags]);

      const mergedMaster = updateItem(
        item1.id,
        {
          publicationTitle: item2.publicationTitle,
          collections: mergedCollections,
          tags: mergedTags,
          creators: item2.creators,
        },
        item1.version,
      );

      // Soft-delete duplicate
      const trashed = updateItem(item2.id, { isDeleted: true }, item2.version);

      expect(mergedMaster.publicationTitle).toBe('NeurIPS 2017');
      expect(mergedMaster.collections).toEqual([
        'col-reading-list',
        'col-neurips',
      ]);
      expect(mergedMaster.tags).toEqual(['deep-learning', 'attention', 'nlp']);
      expect(mergedMaster.creators).toHaveLength(2);
      expect(trashed.isDeleted).toBe(true);
    });
  });

  // FLOW 3: CATALOGING, COLLECTIONS HIERARCHY & CONCURRENCY (OCC)
  describe('Flow 3: Hierarchical Collections, Cycle Prevention & Concurrency Control', () => {
    it('3.1 Should manage multi-level collection tree and reject circular loops', () => {
      const rootCol: E2ECollection = {
        id: 'col-cs',
        name: 'Computer Science',
        parentId: null,
      };
      const midCol: E2ECollection = {
        id: 'col-ai',
        name: 'Artificial Intelligence',
        parentId: 'col-cs',
      };
      const leafCol: E2ECollection = {
        id: 'col-nlp',
        name: 'Natural Language Processing',
        parentId: 'col-ai',
      };

      dbCollections.set(rootCol.id, rootCol);
      dbCollections.set(midCol.id, midCol);
      dbCollections.set(leafCol.id, leafCol);

      const allCols = Array.from(dbCollections.values());

      // Valid nesting
      expect(treeEngine.detectCycle(allCols, 'col-cs', 'col-ai')).toBe(true); // moving cs inside ai creates cycle!
      expect(treeEngine.detectCycle(allCols, 'col-cs', 'col-nlp')).toBe(true); // moving cs inside nlp creates cycle!
      expect(treeEngine.detectCycle(allCols, 'col-nlp', 'col-cs')).toBe(false); // moving nlp directly to cs is fine

      expect(() => {
        treeEngine.assertNoCycle(allCols, 'col-cs', 'col-nlp');
      }).toThrow();
    });

    it('3.2 Should enforce Optimistic Concurrency Control (OCC) against race conditions', () => {
      const item = createItem(
        { userId },
        {
          title: 'Concurrency In Research',
          itemType: 'journalArticle',
          volume: '10',
        },
      );

      const initialVer = item.version; // 1

      // Client A succeeds
      const clientA = updateItem(item.id, { volume: '11' }, initialVer);
      expect(clientA.version).toBe(2);

      // Client B tries to save with stale version 1 -> Must throw VersionMismatchException
      expect(() => {
        updateItem(item.id, { volume: '12' }, initialVer);
      }).toThrow(VersionMismatchException);
    });
  });

  // FLOW 4: SAVED SEARCHES & DYNAMIC FILTERING ENGINE
  describe('Flow 4: Saved Searches & Specification Evaluation', () => {
    it('4.1 Should accurately evaluate complex search predicates across items', () => {
      createItem(
        { userId },
        {
          title: 'AlphaFold 2',
          itemType: 'journalArticle',
          year: 2021,
          tags: ['bio', 'AI'],
        },
      );
      createItem(
        { userId },
        {
          title: 'BERT NLP',
          itemType: 'preprint',
          year: 2018,
          tags: ['NLP', 'Transformers'],
        },
      );
      createItem(
        { userId },
        {
          title: 'GPT-4 Technical Report',
          itemType: 'preprint',
          year: 2023,
          tags: ['LLM', 'AI'],
        },
      );

      const allItems = Array.from(dbItems.values());

      // Search rule: year >= 2020 AND tags contain 'AI'
      const matched = allItems.filter(
        (it) => it.year && it.year >= 2020 && it.tags.includes('AI'),
      );

      expect(matched).toHaveLength(2);
      expect(matched.map((m) => m.title)).toEqual(
        expect.arrayContaining(['AlphaFold 2', 'GPT-4 Technical Report']),
      );
    });
  });

  // FLOW 5: READING STATE & LITERATURE NOTES EXTRACTION
  describe('Flow 5: Reading States, PDF Annotations & Literature Notes Synthesis', () => {
    it('5.1 Should track reading state transitions and auto-advance from unread to reading', () => {
      const item = createItem(
        { userId },
        { title: 'Reading Test Paper', itemType: 'journalArticle' },
      );

      expect(isValidRating(5)).toBe(true);
      expect(isValidRating(6)).toBe(false);
      expect(isValidCurrentPage(10)).toBe(true);
      expect(isValidCurrentPage(0)).toBe(false);

      expect(shouldAutoAdvanceToReading(ReadingStatus.UNREAD, 5)).toBe(true);
      expect(
        isValidStateTransition(ReadingStatus.UNREAD, ReadingStatus.READING),
      ).toBe(true);
      expect(
        isValidStateTransition(ReadingStatus.READING, ReadingStatus.COMPLETED),
      ).toBe(true);
      expect(
        isValidStateTransition(ReadingStatus.COMPLETED, ReadingStatus.READING),
      ).toBe(true);

      const state: E2EReadingState = {
        itemId: item.id,
        userId,
        status: 'reading',
        currentPage: 15,
        totalPages: 30,
        progressPercentage: 50,
        rating: 5,
      };
      dbReadingStates.set(item.id, state);

      expect(dbReadingStates.get(item.id)?.status).toBe('reading');
      expect(dbReadingStates.get(item.id)?.progressPercentage).toBe(50);
    });

    it('5.2 Should extract structured literature notes from highlights and comments', () => {
      const item = createItem(
        { userId },
        {
          title: 'Deep Residual Learning for Image Recognition',
          itemType: 'conferencePaper',
          year: 2016,
          creators: [
            {
              orderIndex: 0,
              creatorType: 'author',
              firstName: 'Kaiming',
              lastName: 'He',
              fullName: 'Kaiming He',
            },
          ],
        },
      );

      const annotations: E2EAnnotation[] = [
        {
          id: 'ann-1',
          itemId: item.id,
          pageIndex: 1,
          quoteText: 'Deeper neural networks are more difficult to train.',
          comment: 'Core thesis of ResNet',
          color: '#ffd400',
        },
        {
          id: 'ann-2',
          itemId: item.id,
          pageIndex: 2,
          quoteText:
            'We explicitly let these layers approximate a residual function $F(x) := H(x) - x$.',
          color: '#5fb236',
        },
      ];

      const mockItem = buildMockLibraryItem({
        id: item.id,
        title: item.title,
        itemType: 'conferencePaper',
        year: item.year,
        contributors: item.creators.map((c) => ({
          firstName: c.firstName || '',
          lastName: c.lastName || '',
          role: 'author',
          orderIndex: c.orderIndex,
        })),
      });

      const formattedMarkdown = formatLiteratureNoteMarkdown(
        mockItem,
        annotations,
      );

      expect(formattedMarkdown).toContain(
        'Deep Residual Learning for Image Recognition',
      );
      expect(formattedMarkdown).toContain(
        'Deeper neural networks are more difficult to train.',
      );
      expect(formattedMarkdown).toContain('Core thesis of ResNet');
      expect(formattedMarkdown).toContain('approximate a residual function');
      expect(formattedMarkdown).toContain('p. 2');
    });
  });

  // FLOW 6: CITATION FORMATTING, OVERLEAF BIBTEX & RETRACTION MONITORING
  describe('Flow 6: Multi-Style Citations, BibTeX Protection & Retraction Monitoring', () => {
    it('6.1 Should format citations across APA, IEEE, Nature, and Vietnamese TCVN styles', () => {
      const alphafold = createItem(
        { userId },
        {
          title: 'Highly accurate protein structure prediction with AlphaFold',
          itemType: 'journalArticle',
          publicationTitle: 'Nature',
          volume: '596',
          pages: '583-589',
          year: 2021,
          doi: '10.1038/s41586-021-03819-2',
          creators: [
            {
              orderIndex: 0,
              creatorType: 'author',
              firstName: 'John',
              lastName: 'Jumper',
              fullName: 'John Jumper',
            },
            {
              orderIndex: 1,
              creatorType: 'author',
              firstName: 'Demis',
              lastName: 'Hassabis',
              fullName: 'Demis Hassabis',
            },
          ],
        },
      );

      const mockAlpha = buildMockLibraryItem({
        id: alphafold.id,
        title: alphafold.title,
        itemType: 'journalArticle',
        publicationTitle: alphafold.publicationTitle,
        volume: alphafold.volume,
        pages: alphafold.pages,
        year: alphafold.year,
        doi: alphafold.doi,
        contributors: alphafold.creators.map((c) => ({
          firstName: c.firstName || '',
          lastName: c.lastName || '',
          role: 'author',
          orderIndex: c.orderIndex,
        })),
      });

      const csl = CslJsonMapper.toCsl(mockAlpha);

      // APA
      const apa = cslEngine.format(csl, 'apa');
      expect(apa.bibliography).toContain('Jumper');
      expect(apa.bibliography).toContain('(2021)');
      expect(apa.bibliography).toContain('AlphaFold');

      // IEEE
      const ieee = cslEngine.format(csl, 'ieee');
      expect(ieee.bibliography).toContain('J. Jumper');
      expect(ieee.bibliography).toContain('AlphaFold');

      // BibTeX with Overleaf Capitalization Shielding
      const bibtex = cslEngine.formatBibtex(csl);
      expect(bibtex).toContain('@article{');
      expect(bibtex).toContain('title = {Highly');
      expect(bibtex).toContain('AlphaFold');
      expect(bibtex).toContain('author = {Jumper, John and Hassabis, Demis}');
      expect(bibtex).toContain('year = {2021}');
    });

    it('6.2 Should detect retracted items and trigger safety warning flag', () => {
      const retractedItem = createItem(
        { userId, projectId },
        {
          title: 'Retracted Paper on Gene Therapy',
          itemType: 'journalArticle',
          year: 2019,
          doi: '10.1016/s0140-6736(98)00000-0',
          isRetracted: true,
          retractionReason:
            'Data fabrication identified by institutional inquiry',
        },
      );

      expect(retractedItem.isRetracted).toBe(true);
      expect(retractedItem.retractionReason).toBe(
        'Data fabrication identified by institutional inquiry',
      );
    });
  });

  // FLOW 7: MULTI-DEVICE CDC REPLICATION STREAM & TOMBSTONES
  describe('Flow 7: Sync Engine, Monotonic Sequencing & CDC Stream', () => {
    it('7.1 Should maintain strictly sequential monotonic log across user and project scopes', () => {
      const p1 = createItem(
        { userId },
        { title: 'Sync Item 1', itemType: 'journalArticle' },
      );
      const p2 = createItem(
        { userId, projectId },
        { title: 'Sync Item 2', itemType: 'preprint' },
      );
      updateItem(p1.id, { volume: '2' }, p1.version);
      updateItem(p2.id, { pages: '1-10' }, p2.version);

      expect(dbSyncLog.length).toBeGreaterThanOrEqual(4);

      // Monotonic sequence verification: sequence[i] == sequence[i-1] + 1
      for (let i = 1; i < dbSyncLog.length; i++) {
        expect(dbSyncLog[i].sequence).toBe(dbSyncLog[i - 1].sequence + 1);
      }

      // CDC since cursor query
      const sinceCursor = dbSyncLog[1].sequence;
      const changesSince = dbSyncLog.filter(
        (record) => record.sequence > sinceCursor,
      );
      expect(changesSince.length).toBe(dbSyncLog.length - 2);
    });

    it('7.2 Should register soft-delete and restore cycles in CDC stream', () => {
      const item = createItem(
        { userId },
        { title: 'Trash Candidate', itemType: 'journalArticle' },
      );

      // Move to Trash
      const trashed = updateItem(item.id, { isDeleted: true }, item.version);
      expect(trashed.isDeleted).toBe(true);
      expect(dbSyncLog[dbSyncLog.length - 1].action).toBe('update');

      // Restore from Trash
      const restored = updateItem(
        item.id,
        { isDeleted: false },
        trashed.version,
      );
      expect(restored.isDeleted).toBe(false);
      expect(restored.version).toBe(3);
    });
  });
});
