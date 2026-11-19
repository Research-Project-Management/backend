import { BadRequestException, ConflictException } from '@nestjs/common';
import { PrismaService } from '@/core';
import { TextDoc } from '@/modules/pages/docstore/domain/text-doc.entity';
import { DocModifiedError } from '@/modules/pages/docstore/domain/doc.errors';
import { DocstoreRepository } from '@/modules/pages/docstore/repositories/docstore.repository';
import { DocstoreService } from '@/modules/pages/docstore/docstore.service';
import {
  assertExpectedVersionAndRev,
  executeDocstoreUpdateWithOcc,
} from '@/modules/pages/docstore/services/doc-occ.helper';
import { PageScaffoldService } from '@/modules/pages/docstore/services/page-scaffold.service';
import { PageService } from '@/modules/pages/core/services/page.service';

const SPACE_ID = '11111111-1111-4111-8111-111111111111';
const PAGE_ID = '22222222-2222-4222-8222-222222222222';
const DOC_ID = '33333333-3333-4333-8333-333333333333';

describe('Khối 2 / Tầng 1 — Docstore, OCC, Range Preservation & Deleted Scoping', () => {
  describe('1. TextDoc canonical spaceId alias', () => {
    it('accepts spaceId on constructor and exposes doc.spaceId === doc.projectId', () => {
      const doc = new TextDoc({
        id: DOC_ID,
        spaceId: SPACE_ID,
        pageId: PAGE_ID,
        path: '/main.tex',
        lines: ['\\section{Intro}'],
        rev: 2,
        version: 4,
      });

      expect(doc.spaceId).toBe(SPACE_ID);
      expect(doc.projectId).toBe(SPACE_ID);
      expect(doc.pageId).toBe(PAGE_ID);
      expect(doc.rev).toBe(2);
    });
  });

  describe('2. DocstoreRepository unarchive & page-scoped trash', () => {
    it('preserves existing PageDoc.ranges when unarchiving without wiping labels or metadata', async () => {
      const updateManyMock = jest
        .fn<
          Promise<{ count: number }>,
          [{ where: unknown; data: Record<string, unknown> }]
        >()
        .mockResolvedValue({ count: 1 });
      const now = new Date('2026-07-01T00:00:00Z');
      const existingRanges = {
        labels: [{ id: 'lbl-1', name: 'Final', color: '#22c55e' }],
        status: 'published',
      };

      const mockPrisma = {
        pageDoc: {
          findFirst: jest.fn().mockResolvedValue({ ranges: existingRanges }),
          updateMany: updateManyMock,
          findUnique: jest.fn().mockResolvedValue({
            id: DOC_ID,
            spaceId: SPACE_ID,
            pageId: PAGE_ID,
            lastKnownPath: 'main.tex',
            lines: ['line 1', 'line 2'],
            rev: 3,
            version: 2,
            ranges: { ...existingRanges, customNote: 'restored' },
            sizeBytes: 13,
            inStorage: false,
            storageKey: null,
            deletedAt: null,
            createdAt: now,
            updatedAt: now,
          }),
        },
      } as unknown as PrismaService;

      const repo = new DocstoreRepository(mockPrisma);

      await repo.unarchiveDoc(SPACE_ID, DOC_ID, ['line 1', 'line 2'], {
        customNote: 'restored',
      });

      const firstUpdateCall = updateManyMock.mock.calls[0][0];
      expect(firstUpdateCall.where).toEqual({
        id: DOC_ID,
        spaceId: SPACE_ID,
        inStorage: true,
      });
      expect(firstUpdateCall.data.inStorage).toBe(false);
      expect(firstUpdateCall.data.storageKey).toBeNull();
      expect(firstUpdateCall.data.ranges).toEqual({
        labels: [{ id: 'lbl-1', name: 'Final', color: '#22c55e' }],
        status: 'published',
        customNote: 'restored',
      });

      // Omitting new ranges still preserves existing ranges instead of overwriting with {}
      updateManyMock.mockClear();
      await repo.unarchiveDoc(SPACE_ID, DOC_ID, ['only line']);
      const secondUpdateCall = updateManyMock.mock.calls[0][0];
      expect(secondUpdateCall.where).toEqual({
        id: DOC_ID,
        spaceId: SPACE_ID,
        inStorage: true,
      });
      expect(secondUpdateCall.data.ranges).toEqual(existingRanges);
    });

    it('filters deleted docs by pageId only when distinct pageId UUID is provided', async () => {
      const findManyMock = jest
        .fn<Promise<unknown[]>, [{ where: Record<string, unknown> }]>()
        .mockResolvedValue([]);
      const mockPrisma = {
        pageDoc: {
          findMany: findManyMock,
        },
      } as unknown as PrismaService;

      const repo = new DocstoreRepository(mockPrisma);
      await repo.getAllDeletedDocs(SPACE_ID, PAGE_ID);
      expect(findManyMock.mock.calls[0][0].where).toEqual({
        spaceId: SPACE_ID,
        deletedAt: { not: null },
        pageId: PAGE_ID,
      });

      findManyMock.mockClear();
      await repo.getAllDeletedDocs(SPACE_ID);
      const callWhere = findManyMock.mock.calls[0][0].where;
      expect(callWhere).toEqual({
        spaceId: SPACE_ID,
        deletedAt: { not: null },
      });
      expect(callWhere).not.toHaveProperty('pageId');
    });
  });

  describe('3. OCC 409 details wrapping & authoritative remoteContent hydration', () => {
    it('wraps currentRev and hydrated remoteContent inside ConflictException details', async () => {
      const getDocMock = jest.fn().mockResolvedValue({
        id: DOC_ID,
        lines: ['% remote header', '\\begin{document}'],
        rev: 6,
        version: 2,
      });
      const mockDocstoreService = {
        getDoc: getDocMock,
      } as unknown as DocstoreService;

      let caught: unknown;
      try {
        await assertExpectedVersionAndRev(
          mockDocstoreService,
          {
            id: DOC_ID,
            spaceId: SPACE_ID,
            rev: 6,
            version: 2,
            inStorage: true,
            lines: [],
          },
          4,
        );
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(ConflictException);
      const response = (caught as ConflictException).getResponse() as {
        code: string;
        details: {
          docId: string;
          expectedRev: number;
          currentRev: number;
          currentVersion: number;
          remoteContent: string;
        };
      };
      expect(response.code).toBe('DOC_VERSION_CONFLICT');
      expect(response.details).toEqual(
        expect.objectContaining({
          docId: DOC_ID,
          expectedRev: 4,
          currentRev: 6,
          currentVersion: 2,
          remoteContent: '% remote header\n\\begin{document}',
        }),
      );
      expect(getDocMock).toHaveBeenCalledWith(SPACE_ID, DOC_ID);
    });

    it('fetches latest document on DocModifiedError race in executeDocstoreUpdateWithOcc', async () => {
      const updateDocMock = jest
        .fn()
        .mockRejectedValue(new DocModifiedError(DOC_ID, 5));
      const getDocMock = jest.fn().mockResolvedValue({
        id: DOC_ID,
        lines: ['latest line from concurrent save'],
        rev: 8,
        version: 4,
      });
      const mockDocstoreService = {
        updateDoc: updateDocMock,
        getDoc: getDocMock,
      } as unknown as DocstoreService;

      let caught: unknown;
      try {
        await executeDocstoreUpdateWithOcc(
          mockDocstoreService,
          { id: DOC_ID, spaceId: SPACE_ID, rev: 5, version: 3 },
          ['stale attempt'],
          3,
          5,
        );
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(ConflictException);
      const response = (caught as ConflictException).getResponse() as {
        details: {
          currentRev: number;
          currentVersion: number;
          remoteContent: string;
        };
      };
      expect(response.details.currentRev).toBe(8);
      expect(response.details.currentVersion).toBe(4);
      expect(response.details.remoteContent).toBe(
        'latest line from concurrent save',
      );
    });
  });

  describe('4. PageService.updatePageContent LineArray sanitization & OCC forwarding', () => {
    function buildPageService(record: Record<string, unknown>) {
      const updateDocMock = jest.fn().mockResolvedValue({
        rev: (record.rev as number) + 1,
        doc: {
          id: DOC_ID,
          projectId: SPACE_ID,
          path: 'main.tex',
          lines: ['normalized line 1', 'line 2'],
          rev: (record.rev as number) + 1,
          version: (record.version as number) + 1,
          ranges: {},
        },
      });
      const docstoreService = {
        updateDoc: updateDocMock,
        getDoc: jest.fn().mockResolvedValue({
          id: DOC_ID,
          lines: ['remote authoritative line'],
          rev: record.rev,
          version: record.version,
        }),
      } as unknown as DocstoreService;

      const mockPrisma = {
        pageDoc: {
          findUnique: jest.fn().mockResolvedValue(record),
          findFirst: jest.fn().mockResolvedValue(record),
          update: jest.fn().mockResolvedValue(record),
        },
        pageNode: {
          findFirst: jest.fn().mockResolvedValue({ name: 'main.tex' }),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        page: {
          findUnique: jest
            .fn()
            .mockResolvedValue({ id: PAGE_ID, title: 'Paper' }),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      } as unknown as PrismaService;

      const service = new PageService(
        mockPrisma,
        docstoreService,
        {} as PageScaffoldService,
      );
      return { service, updateDocMock };
    }

    it('normalizes CRLF line endings via LineArray.textToLines and forwards undefined expectedRev cleanly', async () => {
      const record = {
        id: DOC_ID,
        spaceId: SPACE_ID,
        pageId: PAGE_ID,
        lastKnownPath: 'main.tex',
        lines: ['old line'],
        rev: 3,
        version: 1,
        ranges: {},
        deletedAt: null,
        inStorage: false,
      };
      const { service, updateDocMock } = buildPageService(record);

      await service.updatePageContent(DOC_ID, {
        content: '\ufefffirst line\r\nsecond line',
      });

      expect(updateDocMock).toHaveBeenCalledWith(
        SPACE_ID,
        DOC_ID,
        expect.objectContaining({
          lines: ['first line', 'second line'],
          expectedRev: undefined,
        }),
      );
    });

    it('rejects null-byte payloads with BadRequestException instead of persisting corrupted content', async () => {
      const record = {
        id: DOC_ID,
        spaceId: SPACE_ID,
        pageId: PAGE_ID,
        lastKnownPath: 'main.tex',
        lines: ['safe'],
        rev: 2,
        version: 1,
        ranges: {},
        deletedAt: null,
        inStorage: false,
      };
      const { service, updateDocMock } = buildPageService(record);

      await expect(
        service.updatePageContent(DOC_ID, {
          content: 'abc\u0000def',
          expectedRev: 2,
        }),
      ).rejects.toThrow(BadRequestException);
      expect(updateDocMock).not.toHaveBeenCalled();
    });

    it('rejects stale expectedRev with ConflictException carrying details.currentRev & details.remoteContent', async () => {
      const record = {
        id: DOC_ID,
        spaceId: SPACE_ID,
        pageId: PAGE_ID,
        lastKnownPath: 'main.tex',
        lines: ['remote authoritative line 1', 'remote line 2'],
        rev: 5,
        version: 2,
        ranges: {},
        deletedAt: null,
        inStorage: false,
      };
      const { service, updateDocMock } = buildPageService(record);

      let caught: unknown;
      try {
        await service.updatePageContent(DOC_ID, {
          content: 'stale edit',
          expectedRev: 2,
        });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(ConflictException);
      const response = (caught as ConflictException).getResponse() as {
        details: {
          currentRev: number;
          currentVersion: number;
          remoteContent: string;
        };
      };
      expect(response.details.currentRev).toBe(5);
      expect(response.details.currentVersion).toBe(2);
      expect(response.details.remoteContent).toBe(
        'remote authoritative line 1\nremote line 2',
      );
      expect(updateDocMock).not.toHaveBeenCalled();
    });
  });
});
