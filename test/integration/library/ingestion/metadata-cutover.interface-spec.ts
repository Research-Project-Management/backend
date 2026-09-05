import {
  LibraryTestHarness,
  TestWorkspaceFixture,
} from '../library-test-harness';
import { IngestionService } from '../../../../src/modules/library/ingestion/ingestion.service';
import { CatalogService } from '../../../../src/modules/library/items/items.service';
import {
  METADATA_PORT,
  MetadataPort,
} from '../../../../src/modules/library/ingestion/metadata/types/metadata.types';
import * as fs from 'fs';
import * as path from 'path';

describe('Integration: Canonical Metadata Cutover & Transaction Atomicity', () => {
  let harness: LibraryTestHarness;
  let fixture: TestWorkspaceFixture;
  let ingestionService: IngestionService;
  let canonicalMetadataService: MetadataPort;

  beforeAll(async () => {
    harness = await LibraryTestHarness.create();
    fixture = await harness.seedWorkspaceFixture();

    ingestionService = harness.moduleRef.get(IngestionService);
    canonicalMetadataService =
      harness.moduleRef.get<MetadataPort>(METADATA_PORT);
  });

  afterAll(async () => {
    if (harness) {
      await harness.close();
    }
  });

  describe('1. Ingestion DOI Resolution & Atomic Transaction', () => {
    it('resolves metadata via canonical MetadataService and commits CatalogItem + OutboxEvent in single transaction', async () => {
      const doi = '10.1038/nature12345';
      const mockResolved = {
        query: doi,
        queryType: 'DOI' as const,
        canonicalId: `doi:${doi}`,
        metadata: {
          title: 'Quantum Advantage Demonstration',
          year: 2024,
          journal: 'Nature',
          itemType: 'journalArticle',
          tags: ['Quantum', 'Physics'],
        },
        provenance: {},
        resolvedAt: new Date().toISOString(),
        policyVersion: 1,
      };

      jest
        .spyOn(canonicalMetadataService, 'resolve')
        .mockResolvedValueOnce(mockResolved);

      const itemRes = await ingestionService.ingestDoi(
        fixture.workspaceId,
        fixture.ownerUserId,
        { doi },
      );
      const item = itemRes as any;

      expect(item).toBeDefined();
      expect(item.id).toBeDefined();
      expect(item.title).toBe('Quantum Advantage Demonstration');
      expect(item.doi).toBe(doi);

      // Verify CatalogItem is persisted in DB
      const dbItem = await harness.prisma.catalogItem.findUnique({
        where: { id: item.id },
      });
      expect(dbItem).not.toBeNull();
      expect(dbItem?.title).toBe('Quantum Advantage Demonstration');
      expect(dbItem?.workspaceId).toBe(fixture.workspaceId);

      // Verify Outbox event is persisted in DB
      const outbox = await harness.prisma.outboxEvent.findFirst({
        where: {
          aggregateId: item.id,
          eventType: 'library.item.created',
        },
      });
      expect(outbox).not.toBeNull();
      expect(outbox?.workspaceId).toBe(fixture.workspaceId);
    });

    it('rolls back CatalogItem if an error occurs during transaction execution', async () => {
      const doi = '10.1038/rollback-test';
      const mockResolved = {
        query: doi,
        queryType: 'DOI' as const,
        canonicalId: `doi:${doi}`,
        metadata: {
          title: 'Rollback Paper',
          year: 2024,
          journal: 'Nature',
          itemType: 'journalArticle',
          tags: ['Test'],
        },
        provenance: {},
        resolvedAt: new Date().toISOString(),
        policyVersion: 1,
      };

      jest
        .spyOn(canonicalMetadataService, 'resolve')
        .mockResolvedValueOnce(mockResolved);

      const catalogServiceRef = harness.moduleRef.get(CatalogService);
      const origCreateItem = catalogServiceRef.createItem;
      jest
        .spyOn(catalogServiceRef, 'createItem')
        .mockImplementationOnce(async (wsId, data, opts) => {
          await origCreateItem.call(catalogServiceRef, wsId, data, opts);
          throw new Error('Simulated transaction failure after item creation');
        });

      await expect(
        ingestionService.ingestDoi(fixture.workspaceId, fixture.ownerUserId, {
          doi,
        }),
      ).rejects.toThrow('Simulated transaction failure after item creation');

      // Verify CatalogItem was rolled back and is NOT in DB
      const dbItem = await harness.prisma.catalogItem.findFirst({
        where: {
          workspaceId: fixture.workspaceId,
          title: 'Rollback Paper',
        },
      });
      expect(dbItem).toBeNull();
    });
  });

  describe('2. Ingestion BibTeX Resolution & Atomic Transaction', () => {
    it('ingests BibTeX and creates CatalogItem + OutboxEvent in the same transaction', async () => {
      const bibtex = `@article{nature2024,
        title={Nature Breakthrough 2024},
        author={Scientist One and Scientist Two},
        year={2024}
      }`;

      const itemRes = await ingestionService.ingestBibtex(
        fixture.workspaceId,
        fixture.ownerUserId,
        { bibtex },
      );
      const item = itemRes as any;

      expect(item).toBeDefined();
      expect(item.title).toBe('Nature Breakthrough 2024');

      const dbItem = await harness.prisma.catalogItem.findUnique({
        where: { id: item.id },
      });
      expect(dbItem).not.toBeNull();
      expect(dbItem?.title).toBe('Nature Breakthrough 2024');

      const outbox = await harness.prisma.outboxEvent.findFirst({
        where: {
          aggregateId: item.id,
          eventType: 'library.item.created',
        },
      });
      expect(outbox).not.toBeNull();
    });
  });

  describe('4. Architecture Rules: Canonical Isolation & Zero forwardRef', () => {
    it('Canonical metadata files do NOT import from library/legacy', () => {
      const canonicalDir = path.resolve(
        __dirname,
        '../../../../src/modules/library/ingestion/metadata',
      );

      function checkDir(dir: string) {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            checkDir(fullPath);
          } else if (entry.isFile() && entry.name.endsWith('.ts')) {
            const content = fs.readFileSync(fullPath, 'utf8');
            expect(content).not.toMatch(/from\s+['"].*legacy/);
          }
        }
      }

      checkDir(canonicalDir);
    });

    it('Library modules contain zero forwardRef in metadata wiring', () => {
      const libraryDir = path.resolve(
        __dirname,
        '../../../../src/modules/library',
      );

      function checkDir(dir: string) {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            checkDir(fullPath);
          } else if (entry.isFile() && entry.name.endsWith('.ts')) {
            const content = fs.readFileSync(fullPath, 'utf8');
            expect(content).not.toMatch(/forwardRef/);
          }
        }
      }

      checkDir(libraryDir);
    });
  });
});
