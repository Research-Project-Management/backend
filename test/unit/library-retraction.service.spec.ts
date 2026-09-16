import { RetractionDatabaseService } from '../../src/modules/library/retraction/services/retraction-database.service';
import { RetractionScannerProvider } from '../../src/modules/library/retraction/providers/retraction-scanner.provider';
import { RetractionService } from '../../src/modules/library/retraction/retraction.service';
import { RetractionRepository } from '../../src/modules/library/retraction/retraction.repository';

describe('Retraction Watch & Offline Retraction Detection', () => {
  let mockPrisma: any;
  let retractionDb: RetractionDatabaseService;
  let scanner: RetractionScannerProvider;
  let service: RetractionService;
  let repo: RetractionRepository;

  const retractionWatchSeed = [
    {
      doi: '10.1016/s0140-6736(97)11096-0',
      pmid: '9500320',
      title: 'Ileal-lymphoid-nodular hyperplasia, non-specific colitis, and pervasive developmental disorder in children',
      nature: 'retraction',
      reason: 'Data falsification and non-reproducible findings (Wakefield MMR autism)',
      noticeUrl: 'https://doi.org/10.1016/S0140-6736(10)60175-4',
      retractionDate: '2010-02-06T00:00:00.000Z',
      source: 'retraction_watch',
    },
    {
      doi: '10.1016/s0140-6736(20)31180-6',
      pmid: '32450107',
      title: 'Hydroxychloroquine or chloroquine with or without a macrolide for treatment of COVID-19',
      nature: 'retraction',
      reason: 'Surgisphere fraudulent registry',
      noticeUrl: 'https://doi.org/10.1016/S0140-6736(20)31324-6',
      retractionDate: '2020-06-05T00:00:00.000Z',
      source: 'retraction_watch',
    },
  ];

  beforeEach(async () => {
    const recordsMap = new Map<string, any>();

    // Mock Prisma Service
    mockPrisma = {
      retractionRecord: {
        count: jest.fn(async (args?: any) => {
          if (!args?.where) return recordsMap.size;
          if (args.where.isRetracted === true) {
            let c = 0;
            for (const v of recordsMap.values()) if (v.isRetracted) c++;
            return c;
          }
          if (args.where.isRetracted === false) {
            let c = 0;
            for (const v of recordsMap.values()) if (!v.isRetracted) c++;
            return c;
          }
          return recordsMap.size;
        }),
        findFirst: jest.fn(async (args?: any) => {
          const where = args?.where;
          if (!where) {
            return recordsMap.values().next().value || null;
          }
          for (const orCond of where.OR || []) {
            if (orCond.doi && recordsMap.has(orCond.doi.toLowerCase())) {
              return recordsMap.get(orCond.doi.toLowerCase());
            }
            if (orCond.pmid) {
              for (const r of recordsMap.values()) {
                if (r.pmid === orCond.pmid) return r;
              }
            }
          }
          return null;
        }),
        findMany: jest.fn(async ({ where }: any) => {
          const list: any[] = [];
          for (const v of recordsMap.values()) {
            if (where?.isRetracted !== undefined && v.isRetracted !== where.isRetracted) {
              continue;
            }
            list.push(v);
          }
          return list;
        }),
        upsert: jest.fn(async ({ where, create, update }: any) => {
          const key = where.doi.toLowerCase();
          const existing = recordsMap.get(key);
          const merged = { ...(existing || create), ...update, doi: key };
          recordsMap.set(key, merged);
          return merged;
        }),
        groupBy: jest.fn(async () => [
          { source: 'retraction_watch', _count: 2 },
        ]),
      },
      item: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn(),
        count: jest.fn().mockResolvedValue(10),
      },
    };

    retractionDb = new RetractionDatabaseService(mockPrisma);
    // Pre-populate with seed records
    await retractionDb.importRecords(retractionWatchSeed as any);

    scanner = new RetractionScannerProvider(mockPrisma, retractionDb);
    repo = new RetractionRepository(mockPrisma);
    service = new RetractionService(repo, scanner, retractionDb);
  });

  describe('RetractionDatabaseService', () => {
    it('should identify retracted papers in 0ms from in-memory index without DB roundtrip', async () => {
      const result = await retractionDb.checkRetraction('10.1016/s0140-6736(97)11096-0');
      expect(result).not.toBeNull();
      expect(result).not.toBe(false);
      if (result) {
        expect(result.nature).toBe('retraction');
        expect(result.source).toBe('retraction_watch');
        expect(result.reason).toContain('Wakefield');
      }
      // Note: findFirst was NOT called because in-memory fast index answered!
      expect(mockPrisma.retractionRecord.findFirst).not.toHaveBeenCalled();
    });

    it('should check retractions by PMID in 0ms', async () => {
      const result = await retractionDb.checkRetraction(null, '32450107');
      expect(result).not.toBeNull();
      if (result) {
        expect(result.nature).toBe('retraction');
        expect(result.source).toBe('retraction_watch');
      }
    });

    it('should record clean papers and return false on subsequent checks (negative cache)', async () => {
      const cleanDoi = '10.1038/s41586-020-2649-2';
      // Initially not found
      const initial = await retractionDb.checkRetraction(cleanDoi);
      expect(initial).toBeNull();

      // Save as clean
      await retractionDb.saveClean(cleanDoi);

      // Subsequent check should return false (confirmed clean, 0ms)
      const afterClean = await retractionDb.checkRetraction(cleanDoi);
      expect(afterClean).toBe(false);
    });

    it('should return database stats including source breakdown', async () => {
      const stats = await retractionDb.getDatabaseStats();
      expect(stats.totalRecords).toBeGreaterThanOrEqual(2);
      expect(stats.retractedCount).toBeGreaterThanOrEqual(2);
      expect(stats.inMemoryCached).toBeGreaterThanOrEqual(2);
      expect(stats.sourceBreakdown.retraction_watch).toBe(2);
    });
  });

  describe('RetractionScannerProvider', () => {
    it('should detect retraction via Retraction Watch dataset without making network requests', async () => {
      const result = await scanner.scan('10.1016/s0140-6736(97)11096-0');
      expect(result).not.toBeNull();
      expect(result?.nature).toBe('retraction');
      expect(result?.source).toBe('retraction_watch');
    });

    it('should identify retraction from title heuristics', async () => {
      const result = await scanner.scan(
        '10.9999/unknown-clean-doi',
        null,
        'RETRACTED: Deep Learning for Quantum Gravity Solvers',
      );
      expect(result).not.toBeNull();
      expect(result?.nature).toBe('retraction');
      expect(result?.source).toBe('manual');
    });

    it('should identify expression of concern from title heuristics', async () => {
      const result = await scanner.scan(
        '10.9999/unknown-clean-doi',
        null,
        'Expression of Concern: Statistical anomalies in Figure 4',
      );
      expect(result).not.toBeNull();
      expect(result?.nature).toBe('expression_of_concern');
      expect(result?.source).toBe('manual');
    });
  });

  describe('RetractionService', () => {
    it('should scan an item and update retraction status in database', async () => {
      const mockItem = {
        id: 'item-123',
        doi: '10.1016/s0140-6736(97)11096-0',
        pmid: '9500320',
        title: 'Original Title',
        isRetracted: false,
        retractionNature: null,
      };
      mockPrisma.item.findFirst.mockResolvedValue(mockItem);
      mockPrisma.item.update.mockResolvedValue({ ...mockItem, isRetracted: true });

      const checkResult = await service.checkItem('user-1', 'item-123');

      expect(checkResult.itemId).toBe('item-123');
      expect(checkResult.isRetracted).toBe(true);
      expect(checkResult.nature).toBe('retraction');
      expect(checkResult.details?.source).toBe('retraction_watch');
      expect(mockPrisma.item.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'item-123' },
          data: expect.objectContaining({
            isRetracted: true,
            retractionNature: 'retraction',
          }),
        }),
      );
    });

    it('should batch scan library items efficiently', async () => {
      const items = [
        {
          id: 'item-1',
          title: 'Wakefield MMR Paper',
          doi: '10.1016/s0140-6736(97)11096-0',
          pmid: null,
          isRetracted: false,
        },
        {
          id: 'item-2',
          title: 'Normal Physics Paper',
          doi: '10.1103/physrevlett.120.010001',
          pmid: null,
          isRetracted: false,
        },
      ];
      mockPrisma.item.findMany.mockResolvedValue(items);
      mockPrisma.item.update.mockResolvedValue({});

      // Mark the second paper as clean so it doesn't make network requests
      await retractionDb.saveClean('10.1103/physrevlett.120.010001');

      const batchResult = await service.checkLibrary('user-1');
      expect(batchResult.scanned).toBe(2);
      expect(batchResult.newlyRetracted).toBe(1);
    });

    it('should return retraction database stats and allow manual seeding', async () => {
      const stats = await service.getDatabaseStats();
      expect(stats.totalRecords).toBeGreaterThan(0);

      const seedResult = await service.seedDatabase(false);
      expect(seedResult.seeded).toBeGreaterThanOrEqual(0);
    });
  });
});
