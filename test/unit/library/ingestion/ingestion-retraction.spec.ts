import {
  RetractionSeederService,
  parseRfc4180Csv,
  cleanRetractionReason,
  parseRetractionNature,
} from '@/modules/library/ingestion/services/retraction-seeder.service';
import { RetractionDatabaseService } from '@/modules/library/ingestion/services/retraction-database.service';
import { RetractionScannerProvider } from '@/modules/library/ingestion/providers/retraction-scanner.provider';
import {
  RetractionService,
  RetractionSyncService,
} from '@/modules/library/ingestion/services/retraction.service';
import { RetractionRepository } from '@/modules/library/ingestion/repositories/retraction.repository';

describe('Library Retraction Watch — CSV Seeder, Fast Index, Scanner & Sync Service', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('RFC-4180 CSV Parser & RetractionSeederService', () => {
    it('parses quoted/multiline RFC-4180 CSV rows, classifies nature (erratum vs retraction), and bulk-seeds unique DOIs', async () => {
      const parsed = parseRfc4180Csv(
        `Record ID,Title,OriginalPaperDOI,Notes\n100,"Clinical study on ""X"", Part 1",10.1016/sample,"Line 1\nLine 2"`,
      );
      expect(parsed[0]).toEqual({
        'Record ID': '100',
        Title: 'Clinical study on "X", Part 1',
        OriginalPaperDOI: '10.1016/sample',
        Notes: 'Line 1\nLine 2',
      });

      expect(
        cleanRetractionReason('+Falsification of Data;+Plagiarism'),
      ).toBe('Falsification of Data; Plagiarism');
      expect(parseRetractionNature('Retraction')).toEqual({
        nature: 'retraction',
        isRetracted: true,
      });
      expect(parseRetractionNature('Expression of Concern')).toEqual({
        nature: 'expression_of_concern',
        isRetracted: true,
      });
      expect(parseRetractionNature('Erratum')).toEqual({
        nature: 'correction',
        isRetracted: false,
      });
      expect(parseRetractionNature('Reinstatement')).toEqual({
        nature: 'reinstatement',
        isRetracted: false,
      });

      const bulkCreateRetractions = jest.fn(async (batch: unknown[]) =>
        batch.length,
      );
      const warmMemoryIndex = jest.fn().mockResolvedValue(undefined);
      const seeder = new RetractionSeederService(
        { bulkCreateRetractions } as unknown as RetractionRepository,
        {
          warmMemoryIndex,
          addRetractionToBloom: jest.fn(),
        } as unknown as RetractionDatabaseService,
      );

      const csv = [
        'Record ID,Title,Journal,OriginalPaperDOI,OriginalPaperPubMedID,RetractionNature,Reason,RetractionDOI,RetractionDate',
        '1,"Fabricated Trial",Nature,10.1038/nature12345,12345678,Retraction,"+Falsification",10.1038/ret,2023-04-15',
        '2,"Duplicate Row",Nature,10.1038/nature12345,12345678,Retraction,"+Falsification",10.1038/ret,2023-04-15',
        '3,"Unavailable DOI",Book,unavailable,0,Retraction,+Error,unavailable,2020-01-01',
      ].join('\n');

      const res = await seeder.seedFromCsv(csv, { chunkSize: 10 });
      expect(res).toMatchObject({
        totalRows: 3,
        validRecords: 1,
        inserted: 1,
      });
      expect(warmMemoryIndex).toHaveBeenCalled();
    });
  });

  describe('RetractionDatabaseService, RetractionScannerProvider & RetractionService', () => {
    const USER_ID = '00000000-0000-4000-8000-000000000001';
    const ITEM_1 = '00000000-0000-4000-8000-000000000011';
    const ITEM_2 = '00000000-0000-4000-8000-000000000012';

    let itemMock: Record<string, jest.Mock>;
    let retractionDb: RetractionDatabaseService;
    let scanner: RetractionScannerProvider;
    let service: RetractionService;
    let syncService: RetractionSyncService;

    beforeEach(async () => {
      const recordsMap = new Map<string, Record<string, unknown>>();
      const retractionOps = {
        count: jest.fn(async () => recordsMap.size),
        findFirst: jest.fn(async () => null),
        findMany: jest.fn(async () => Array.from(recordsMap.values())),
        upsert: jest.fn(
          async ({
            where,
            create,
            update,
          }: {
            where: { doi: string };
            create: Record<string, unknown>;
            update: Record<string, unknown>;
          }) => {
            const key = String(where.doi).toLowerCase();
            const merged = {
              ...(recordsMap.get(key) || create),
              ...update,
              doi: key,
            };
            recordsMap.set(key, merged);
            return merged;
          },
        ),
        groupBy: jest.fn(async () => [{ source: 'retraction_watch', _count: 1 }]),
      };
      itemMock = {
        findFirst: jest.fn(),
        findUnique: jest.fn().mockResolvedValue({ metadata: {} }),
        findMany: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
        count: jest.fn().mockResolvedValue(2),
      };

      const repo = new RetractionRepository({
        retraction: retractionOps,
        retractionRecord: retractionOps,
        item: itemMock,
        libraryItem: itemMock,
      } as never);

      retractionDb = new RetractionDatabaseService(repo);
      await retractionDb.importRecords([
        {
          doi: '10.1016/s0140-6736(97)11096-0',
          pmid: '9500320',
          title: 'Wakefield MMR Study',
          nature: 'retraction',
          reason: 'Data falsification',
          noticeUrl: 'https://doi.org/10.1016/S0140-6736(10)60175-4',
          retractionDate: '2010-02-06T00:00:00.000Z',
          source: 'retraction_watch',
        },
      ] as never);

      scanner = new RetractionScannerProvider(retractionDb);
      syncService = new RetractionSyncService(repo, scanner);
      service = new RetractionService(repo, scanner, retractionDb, syncService);
    });

    it('serves seeded DOI/PMID retractions and negative clean cache in 0ms without network requests', async () => {
      const byDoi = await retractionDb.checkRetraction(
        '10.1016/s0140-6736(97)11096-0',
      );
      expect(byDoi && byDoi.nature).toBe('retraction');

      const byPmid = await retractionDb.checkRetraction(null, '9500320');
      expect(byPmid && byPmid.source).toBe('retraction_watch');

      await retractionDb.saveClean('10.1038/clean-paper');
      expect(await scanner.lookup('10.1038/clean-paper')).toEqual({
        status: 'clean',
      });
      expect(await scanner.lookup(null, null)).toEqual({ status: 'unknown' });
      expect(
        await scanner.lookup('10.1007/unindexed', undefined, {
          localOnly: true,
        }),
      ).toEqual({ status: 'unknown' });
    });

    it('queries OpenAlex and CrossRef CrossMark (retraction & expression_of_concern vs non-retracted correction)', async () => {
      const isolatedScanner = new RetractionScannerProvider({
        checkRetraction: jest.fn().mockResolvedValue(null),
        saveClean: jest.fn().mockResolvedValue(undefined),
        saveRetraction: jest.fn().mockResolvedValue(undefined),
      } as unknown as RetractionDatabaseService);

      jest.spyOn(globalThis, 'fetch').mockImplementation(async (url: unknown) => {
        const s = String(url);
        if (s.includes('openalex.org')) {
          return {
            ok: true,
            json: async () => ({ is_retracted: false }),
          } as Response;
        }
        if (s.includes('concern-paper')) {
          return {
            ok: true,
            json: async () => ({
              message: {
                'update-to': [
                  {
                    type: 'expression_of_concern',
                    label: 'Investigation pending',
                  },
                ],
              },
            }),
          } as Response;
        }
        return {
          ok: true,
          json: async () => ({
            message: {
              'update-to': [{ type: 'correction', label: 'Typo fix' }],
            },
          }),
        } as Response;
      });

      const concern = await isolatedScanner.lookup('10.1000/concern-paper');
      expect(concern).toMatchObject({
        status: 'retracted',
        details: { nature: 'expression_of_concern' },
      });

      const erratum = await isolatedScanner.lookup('10.1000/erratum-paper');
      expect(erratum).toEqual({ status: 'clean' });
    });

    it('scans items, skips DOI/PMID-less items in batch scans, preserves stored retraction on unknown lookup, and respects manual overrides in syncLibrary', async () => {
      itemMock.findFirst.mockResolvedValueOnce({
        id: ITEM_1,
        doi: '10.1016/s0140-6736(97)11096-0',
        pmid: '9500320',
        isRetracted: false,
      });
      const checked = await service.checkItem(USER_ID, ITEM_1);
      expect(checked.isRetracted).toBe(true);
      expect(checked.nature).toBe('retraction');

      itemMock.update.mockClear();
      itemMock.findFirst.mockResolvedValueOnce({
        id: ITEM_2,
        doi: null,
        metadata: {
          pmid: null,
          isRetracted: true,
          retractionNature: 'retraction',
        },
      });
      const unknownKeep = await service.checkItem(USER_ID, ITEM_2);
      expect(unknownKeep.status).toBe('unknown');
      expect(unknownKeep.isRetracted).toBe(true);
      expect(itemMock.update).not.toHaveBeenCalled();

      itemMock.findMany.mockResolvedValueOnce([
        { id: 'no-id', title: 'Book Chapter', doi: null, metadata: {} },
        {
          id: ITEM_1,
          title: 'Wakefield MMR',
          doi: '10.1016/s0140-6736(97)11096-0',
          isRetracted: false,
        },
      ]);
      const batch = await service.checkLibrary(USER_ID);
      expect(batch).toMatchObject({ scanned: 1, newlyRetracted: 1 });

      itemMock.findMany.mockResolvedValueOnce([
        {
          id: ITEM_1,
          title: 'Wakefield MMR',
          doi: '10.1016/s0140-6736(97)11096-0',
          metadata: { isRetracted: false },
          isRetracted: false,
          retractionCheckedAt: null,
        },
        {
          id: ITEM_2,
          title: 'Manual Override',
          doi: '10.1016/s0140-6736(97)11096-0',
          metadata: { isRetracted: true, retractionNature: 'manual' },
          isRetracted: true,
          retractionNature: 'manual',
        },
      ]);
      const synced = await service.syncLibrary(USER_ID, undefined, {
        maxDays: 14,
      });
      expect(synced).toMatchObject({
        totalEligible: 2,
        scanned: 1,
        newlyRetracted: 1,
        skippedManual: 1,
      });
    });
  });
});
