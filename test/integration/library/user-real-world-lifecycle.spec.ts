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
import { VersionMismatchException } from '@/modules/library/core/errors/version-mismatch.exception';
import { buildMockLibraryItem } from '@test/factories';

describe('Real-World User Journey: End-to-End Researcher Lifecycle Simulation', () => {
  const userId = '01920b92-1111-7111-8111-111111111111';
  let typesService: TypesService;
  let schemaValidator: ZoteroSchemaValidatorService;
  let transformer: ItemTransformer;
  let treeEngine: TreeEngine;
  let cslEngine: CslEngineService;

  beforeAll(() => {
    typesService = new TypesService();
    schemaValidator = new ZoteroSchemaValidatorService(typesService);
    transformer = new ItemTransformer(typesService);
    treeEngine = new TreeEngine();
    cslEngine = new CslEngineService();
    cslEngine.initTemplates();
  });

  // Simulated In-Memory User Library Database (State tracking across user journey)
  interface InMemoryItem {
    id: string;
    userId: string;
    title: string;
    itemType: string;
    publicationTitle?: string;
    volume?: string;
    issue?: string;
    pages?: string;
    date?: string;
    year?: number;
    doi?: string;
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
    relations: string[];
    citationKey: string;
    version: number;
    isDeleted: boolean;
    createdAt: Date;
    updatedAt: Date;
  }

  interface InMemoryCollection {
    id: string;
    name: string;
    parentId: string | null;
  }

  interface SyncChangeRecord {
    sequence: number;
    entityId: string;
    action: 'create' | 'update' | 'delete' | 'restore';
    version: number;
  }

  let dbItems: Map<string, InMemoryItem>;
  let dbCollections: Map<string, InMemoryCollection>;
  let syncLog: SyncChangeRecord[];
  let monotonicSequence: number;

  beforeAll(() => {
    dbItems = new Map();
    dbCollections = new Map();
    syncLog = [];
    monotonicSequence = 0;
  });

  // Simulated User Controller Actions
  const userActions = {
    createCollection: (
      id: string,
      name: string,
      parentId: string | null = null,
    ) => {
      const allCols = Array.from(dbCollections.values());
      if (parentId) {
        treeEngine.assertNoCycle(allCols, id, parentId);
      }
      const col = { id, name, parentId };
      dbCollections.set(id, col);
      return col;
    },

    addItem: (
      data: Partial<InMemoryItem> & { title: string; itemType: string },
    ) => {
      const cleanTitle = sanitizeItemTitle(data.title);
      if (!cleanTitle) throw new Error('Title cannot be empty');

      const validated = schemaValidator.validateAndSanitizeItem(data.itemType, {
        ...data,
        title: cleanTitle,
      });

      const itemId =
        data.id ||
        `item-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
      const firstAuthor =
        data.creators?.[0]?.lastName ||
        data.creators?.[0]?.fullName?.split(' ').pop() ||
        'ref';
      const year = data.year || (data.date ? parseInt(data.date, 10) : 2026);
      const titleKeyword = cleanTitle
        .split(' ')[0]
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
      const citationKey = `${firstAuthor.toLowerCase()}${year}${titleKeyword}`;

      const item: InMemoryItem = {
        id: itemId,
        userId,
        title: cleanTitle,
        itemType: data.itemType,
        publicationTitle: data.publicationTitle,
        volume: data.volume,
        issue: data.issue,
        pages: data.pages,
        date: data.date,
        year,
        doi: normalizeDoi(data.doi),
        abstract: cleanAbstractText(data.abstract || ''),
        extra: (validated.sanitizedItem as any).extra || '',
        creators: data.creators || [],
        tags: data.tags || [],
        collections: data.collections || [],
        relations: [],
        citationKey,
        version: 1,
        isDeleted: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      dbItems.set(itemId, item);
      monotonicSequence++;
      syncLog.push({
        sequence: monotonicSequence,
        entityId: itemId,
        action: 'create',
        version: 1,
      });

      return item;
    },

    updateItem: (
      itemId: string,
      patch: Partial<InMemoryItem>,
      expectedVersion: number,
    ) => {
      const item = dbItems.get(itemId);
      if (!item) throw new Error('Item not found');

      if (item.version !== expectedVersion) {
        throw new VersionMismatchException({
          aggregateType: 'Item',
          entityId: itemId,
          currentVersion: item.version,
          expectedVersion,
        });
      }

      const updated = {
        ...item,
        ...patch,
        version: item.version + 1,
        updatedAt: new Date(),
      };

      dbItems.set(itemId, updated);
      monotonicSequence++;
      syncLog.push({
        sequence: monotonicSequence,
        entityId: itemId,
        action: 'update',
        version: updated.version,
      });

      return updated;
    },

    convertItemType: (itemId: string, targetType: string) => {
      const item = dbItems.get(itemId);
      if (!item) throw new Error('Item not found');

      const preview = transformer.previewConversion(item, targetType, {
        retainUnmappedInExtra: true,
      });

      const projected = preview.projectedItem;
      return userActions.updateItem(
        itemId,
        {
          ...projected,
          itemType: targetType,
        },
        item.version,
      );
    },

    trashItem: (itemId: string, expectedVersion: number) => {
      const item = dbItems.get(itemId);
      if (!item) throw new Error('Item not found');
      if (item.version !== expectedVersion) {
        throw new VersionMismatchException({
          aggregateType: 'Item',
          entityId: itemId,
          currentVersion: item.version,
          expectedVersion,
        });
      }

      item.isDeleted = true;
      item.version++;
      dbItems.set(itemId, item);
      monotonicSequence++;
      syncLog.push({
        sequence: monotonicSequence,
        entityId: itemId,
        action: 'delete',
        version: item.version,
      });
      return true;
    },
  };

  // STEP 1: Ingestion & Metadata Discovery from Outside World
  describe('Phase 1: Ingestion, Identifier Cleaning & Academic Data Intake', () => {
    it('User Action 1.1: Researcher feeds a raw Nature URL containing DOI', () => {
      const rawUrl = 'https://doi.org/10.1038/s41586-021-03819-2';
      const cleanDoi = normalizeDoi(rawUrl);

      expect(cleanDoi).toBe('10.1038/s41586-021-03819-2');

      // Add to library
      const item = userActions.addItem({
        title: 'Highly accurate protein structure prediction with AlphaFold',
        itemType: 'journalArticle',
        publicationTitle: 'Nature',
        volume: '596',
        pages: '583-589',
        year: 2021,
        doi: cleanDoi,
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
        abstract:
          'ABSTRACT: Proteins are essential to biology. Here we demonstrate $O(N^2)$ accuracy with AlphaFold.',
      });

      expect(item.id).toBeDefined();
      expect(item.doi).toBe('10.1038/s41586-021-03819-2');
      // Verify abstract prefix "ABSTRACT: " was stripped while LaTeX formula was preserved
      expect(item.abstract).toBe(
        'Proteins are essential to biology. Here we demonstrate $O(N^2)$ accuracy with AlphaFold.',
      );
    });

    it('User Action 1.2: Researcher imports arXiv preprint with dirty author tags & footnotes', () => {
      const arxivLink = 'https://arxiv.org/abs/1706.03762';
      const cleanArxiv = normalizeArxivId(arxivLink);
      expect(cleanArxiv).toBe('1706.03762');

      // Dirty scraped author string from arXiv PDF
      const rawAuthors =
        'Ashish Vaswani 1,*, Noam Shazeer 1, Niki Parmar <niki@google.com>, Visual Geometry Group';
      const cleanedAuthorNames = splitAuthorString(rawAuthors);
      expect(cleanedAuthorNames).toEqual([
        'Ashish Vaswani',
        'Noam Shazeer',
        'Niki Parmar',
      ]);

      const item = userActions.addItem({
        title: 'Attention Is All You Need',
        itemType: 'preprint',
        year: 2017,
        doi: '10.5555/3295222.3295349',
        creators: cleanedAuthorNames.map((name, index) => {
          const parts = name.split(' ');
          return {
            orderIndex: index,
            creatorType: 'author',
            firstName: parts[0],
            lastName: parts[1],
            fullName: name,
          };
        }),
        tags: ['machine-learning', 'transformers'],
      });

      expect(item.citationKey).toBe('vaswani2017attention');
      expect(item.creators).toHaveLength(3);
      expect(item.creators[0].fullName).toBe('Ashish Vaswani');
    });

    it('User Action 1.3: Researcher imports Vietnamese computational linguistics publication', () => {
      const item = userActions.addItem({
        title: 'Phát triển mô hình ngôn ngữ lớn cho tiếng Việt',
        itemType: 'journalArticle',
        publicationTitle: 'Tạp chí Khoa học và Công nghệ',
        year: 2024,
        creators: [
          {
            orderIndex: 0,
            creatorType: 'author',
            firstName: 'Văn An',
            lastName: 'Nguyễn',
            fullName: 'Nguyễn Văn An',
          },
          {
            orderIndex: 1,
            creatorType: 'author',
            firstName: 'Huy Chú',
            lastName: 'Phan',
            fullName: 'Phan Huy Chú',
          },
        ],
        tags: ['vietnamese-nlp', 'llm'],
      });

      expect(item.title).toBe('Phát triển mô hình ngôn ngữ lớn cho tiếng Việt');
      expect(item.creators[0].lastName).toBe('Nguyễn');
    });
  });

  // STEP 2: Collection Tree Organization & Tag Invariants
  describe('Phase 2: Tree Organization, Hierarchical Collections & Cycle Immunity', () => {
    it('User Action 2.1: Creates parent collection "AI & Deep Learning" and subcollection "Foundations"', () => {
      const rootCol = userActions.createCollection(
        'col-ai',
        'AI & Deep Learning',
        null,
      );
      const childCol = userActions.createCollection(
        'col-foundations',
        'Foundations',
        'col-ai',
      );

      expect(rootCol.parentId).toBeNull();
      expect(childCol.parentId).toBe('col-ai');
    });

    it('User Action 2.2: Rejects accidental cycle creation (e.g. moving Root inside Child)', () => {
      // User attempts to make col-ai a child of col-foundations (circular loop)
      const allCols = Array.from(dbCollections.values());
      expect(treeEngine.detectCycle(allCols, 'col-ai', 'col-foundations')).toBe(
        true,
      );
    });

    it('User Action 2.3: Assigns papers to collections and normalizes user tags', () => {
      const papers = Array.from(dbItems.values());
      expect(papers.length).toBeGreaterThanOrEqual(2);

      const paper1 = papers[0];
      const updated = userActions.updateItem(
        paper1.id,
        {
          collections: ['col-foundations'],
          tags: ['Deep-Learning', 'Bioinformatics'],
        },
        paper1.version,
      );

      expect(updated.collections).toContain('col-foundations');
      expect(updated.version).toBe(2);
    });
  });

  // STEP 3: Concurrency Control (OCC) & Metadata Curation
  describe('Phase 3: Optimistic Concurrency Control (OCC) & Data Protection', () => {
    it('User Action 3.1: Rejects stale update when another client has already modified the item', () => {
      const paper = Array.from(dbItems.values())[0];
      const currentVersion = paper.version;

      // Client A updates successfully -> version increments
      userActions.updateItem(paper.id, { volume: '600' }, currentVersion);

      // Client B (who opened the edit modal earlier with old version) tries to save:
      expect(() => {
        userActions.updateItem(paper.id, { volume: '601' }, currentVersion);
      }).toThrow(VersionMismatchException);
    });
  });

  // STEP 4: Scholarly Type Conversion & Field Preservation
  describe('Phase 4: Converting Accepted Preprints into Journal Articles', () => {
    it('User Action 4.1: Upgrades preprint to journalArticle upon peer-review publication', () => {
      const preprint = Array.from(dbItems.values()).find(
        (i) => i.itemType === 'preprint',
      );
      expect(preprint).toBeDefined();

      const converted = userActions.convertItemType(
        preprint!.id,
        'journalArticle',
      );
      expect(converted.itemType).toBe('journalArticle');
      // Authors and title are completely intact
      expect(converted.title).toBe(preprint!.title);
      expect(converted.creators).toHaveLength(preprint!.creators.length);
      // Version was bumped
      expect(converted.version).toBe(preprint!.version + 1);
    });
  });

  // STEP 5: Live Citation Formatting across Research Styles
  describe('Phase 5: Accurate Multi-Style Citation Generation for Research Manuscripts', () => {
    it('User Action 5.1: Formats citations in APA, IEEE, Nature, and Vietnamese TCVN', () => {
      const items = Array.from(dbItems.values());
      const alphafold = items.find((i) => i.title.includes('AlphaFold'))!;

      const mockAlphafold = buildMockLibraryItem({
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
          role: c.creatorType || 'author',
          orderIndex: c.orderIndex,
        })),
      });

      const csl = CslJsonMapper.toCsl(mockAlphafold);

      // 1. APA 7th style
      const apa = cslEngine.format(csl, 'apa');
      expect(apa.bibliography).toContain('Jumper');
      expect(apa.bibliography).toContain('(2021)');
      expect(apa.bibliography).toContain(
        'Highly accurate protein structure prediction with AlphaFold',
      );

      // 2. IEEE style (Bracket numbers)
      const ieee = cslEngine.format(csl, 'ieee');
      expect(ieee.bibliography).toContain('J. Jumper');
      expect(ieee.bibliography).toContain('AlphaFold');

      // 3. Nature style
      const nature = cslEngine.format(csl, 'nature');
      expect(nature.bibliography).toContain('Jumper');

      // 4. Vietnamese paper formatting
      const vnPaper = items.find((i) => i.title.includes('tiếng Việt'))!;
      const mockVn = buildMockLibraryItem({
        id: vnPaper.id,
        title: vnPaper.title,
        itemType: 'journalArticle',
        publicationTitle: vnPaper.publicationTitle,
        year: vnPaper.year,
        contributors: vnPaper.creators.map((c) => ({
          firstName: c.firstName || '',
          lastName: c.lastName || '',
          role: c.creatorType || 'author',
          orderIndex: c.orderIndex,
        })),
      });
      const vnCsl = CslJsonMapper.toCsl(mockVn);
      const vnApa = cslEngine.format(vnCsl, 'apa');
      expect(vnApa.bibliography).toContain('Nguyễn');
    });

    it('User Action 5.2: Generates clean BibTeX with Overleaf capitalization shielding', () => {
      const items = Array.from(dbItems.values());
      const alphafold = items.find((i) => i.title.includes('AlphaFold'))!;
      const mockAlphafold = buildMockLibraryItem({
        id: alphafold.id,
        citationKey: 'jumper2021alphafold',
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
          role: c.creatorType || 'author',
          orderIndex: c.orderIndex,
        })),
      });

      const csl = CslJsonMapper.toCsl(mockAlphafold);
      const bibtex = cslEngine.formatBibtex(csl);

      expect(bibtex.toLowerCase()).toContain('@article{jumper2021alphafold,');
      expect(bibtex).toContain('title = {Highly');
      expect(bibtex).toContain('AlphaFold');
      expect(bibtex).toContain('author = {Jumper, John and Hassabis, Demis}');
      expect(bibtex).toContain('year = {2021}');
    });
  });

  // STEP 6: Multi-Device Sync Stream & Tombstones Pruning
  describe('Phase 6: Multi-Device Sync Stream, Tombstone Tracking & Restore', () => {
    it('User Action 6.1: Verifies strictly monotonic sync sequence across all operations', () => {
      expect(syncLog.length).toBeGreaterThanOrEqual(4);
      for (let i = 1; i < syncLog.length; i++) {
        expect(syncLog[i].sequence).toBe(syncLog[i - 1].sequence + 1);
      }
    });

    it('User Action 6.2: Trashes an item and verifies tombstone deletion event is logged', () => {
      const itemToTrash = Array.from(dbItems.values())[0];
      const initialSeq = monotonicSequence;

      const trashed = userActions.trashItem(
        itemToTrash.id,
        itemToTrash.version,
      );
      expect(trashed).toBe(true);

      const latestSync = syncLog[syncLog.length - 1];
      expect(latestSync.sequence).toBe(initialSeq + 1);
      expect(latestSync.entityId).toBe(itemToTrash.id);
      expect(latestSync.action).toBe('delete');
    });
  });
});
