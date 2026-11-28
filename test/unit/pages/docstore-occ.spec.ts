import { BadRequestException, ConflictException } from '@nestjs/common';
import { PrismaService } from '@/core';
import {
  DocModifiedError,
  DocstoreRepository,
  DocstoreService,
  TextDoc,
  assertExpectedVersionAndRev,
  executeDocstoreUpdateWithOcc,
  findPageRecordWithNode,
} from '@/modules/pages/docstore';
import { PageScaffoldService, PageService } from '@/modules/pages/page';
import { applyPageMetadataAndTitleUpdates } from '@/modules/pages/page/services/content.service';

const SPACE_ID = '11111111-1111-4111-8111-111111111111';
const PAGE_ID = '22222222-2222-4222-8222-222222222222';
const DOC_ID = '33333333-3333-4333-8333-333333333333';

describe('Pages Docstore, OCC & Metadata Seam', () => {
  describe('TextDoc & DocstoreRepository range preservation', () => {
    it('exposes canonical spaceId/projectId on TextDoc and merges existing PageDoc.ranges on unarchive', async () => {
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

      const now = new Date('2026-07-01T00:00:00Z');
      const existingRanges = {
        labels: [{ id: 'lbl-1', name: 'Final', color: '#22c55e' }],
        status: 'published',
      };
      const updateManyMock = jest.fn().mockResolvedValue({ count: 1 });
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
      expect(updateManyMock.mock.calls[0][0].data.ranges).toEqual({
        ...existingRanges,
        customNote: 'restored',
      });

      updateManyMock.mockClear();
      await repo.unarchiveDoc(SPACE_ID, DOC_ID, ['only line']);
      expect(updateManyMock.mock.calls[0][0].data.ranges).toEqual(
        existingRanges,
      );
    });

    it('cleans up orphan S3 object when cold-tier archiveAllDocs loses an OCC race', async () => {
      const candidateDoc = new TextDoc({
        id: DOC_ID,
        spaceId: SPACE_ID,
        pageId: PAGE_ID,
        path: 'main.tex',
        lines: ['\\documentclass{article}'],
        rev: 7,
        version: 3,
      });
      const sendStream = jest.fn().mockResolvedValue(undefined);
      const deleteObject = jest.fn().mockResolvedValue(undefined);
      const docstore = new DocstoreService(
        {
          getAllDocs: jest.fn().mockResolvedValue([candidateDoc]),
          markAsArchived: jest.fn().mockResolvedValue(false),
        } as unknown as DocstoreRepository,
        {
          sendStream,
          getObjectStream: jest.fn(),
          getObjectMd5Hash: jest.fn(),
          deleteObject,
          isDurableStorageConfigured: () => true,
        },
      );

      const archivedCount = await docstore.archiveAllDocs(SPACE_ID);
      const expectedKey = `${SPACE_ID}/${DOC_ID}-7.json`;
      expect(archivedCount).toBe(0);
      expect(sendStream).toHaveBeenCalledWith(
        expectedKey,
        expect.anything(),
        expect.objectContaining({ sourceMd5: expect.any(String) }),
      );
      expect(deleteObject).toHaveBeenCalledWith(expectedKey);
    });
  });

  describe('OCC 409 conflict details & PageService content sanitization', () => {
    it('hydrates remoteContent and currentRev on pre-check mismatch and concurrent DocModifiedError race', async () => {
      const getDocMock = jest.fn().mockResolvedValue({
        id: DOC_ID,
        lines: ['% remote header', '\\begin{document}'],
        rev: 6,
        version: 2,
      });

      let preCheckErr: unknown;
      try {
        await assertExpectedVersionAndRev(
          { getDoc: getDocMock } as unknown as DocstoreService,
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
        preCheckErr = err;
      }

      expect(preCheckErr).toBeInstanceOf(ConflictException);
      expect((preCheckErr as ConflictException).getResponse()).toMatchObject({
        code: 'DOC_VERSION_CONFLICT',
        details: {
          docId: DOC_ID,
          expectedRev: 4,
          currentRev: 6,
          currentVersion: 2,
          remoteContent: '% remote header\n\\begin{document}',
        },
      });

      let raceErr: unknown;
      try {
        await executeDocstoreUpdateWithOcc(
          {
            updateDoc: jest.fn().mockRejectedValue(
              new DocModifiedError('Conflict', {
                docId: DOC_ID,
                rev: 5,
                currentRev: 8,
              }),
            ),
            getDoc: jest.fn().mockResolvedValue({
              id: DOC_ID,
              lines: ['latest line from concurrent save'],
              rev: 8,
              version: 4,
            }),
          } as unknown as DocstoreService,
          { id: DOC_ID, spaceId: SPACE_ID, rev: 5, version: 3 },
          ['stale attempt'],
          3,
          5,
        );
      } catch (err) {
        raceErr = err;
      }

      expect(raceErr).toBeInstanceOf(ConflictException);
      expect((raceErr as ConflictException).getResponse()).toMatchObject({
        details: {
          currentRev: 8,
          currentVersion: 4,
          remoteContent: 'latest line from concurrent save',
        },
      });
    });

    it('normalizes BOM/CRLF, rejects null bytes with 400, and rejects stale expectedRev with 409', async () => {
      const buildPageService = (record: Record<string, unknown>) => {
        const updateDocMock = jest.fn().mockResolvedValue({
          rev: (record.rev as number) + 1,
          doc: {
            id: DOC_ID,
            projectId: SPACE_ID,
            path: 'main.tex',
            lines: ['first line', 'second line'],
            rev: (record.rev as number) + 1,
            version: (record.version as number) + 1,
            ranges: {},
          },
        });
        const service = new PageService(
          {
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
          } as unknown as PrismaService,
          {
            updateDoc: updateDocMock,
            getDoc: jest.fn().mockResolvedValue({
              id: DOC_ID,
              lines: record.lines,
              rev: record.rev,
              version: record.version,
            }),
          } as unknown as DocstoreService,
          {} as PageScaffoldService,
        );
        return { service, updateDocMock };
      };

      const baseRecord = {
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

      const { service, updateDocMock } = buildPageService(baseRecord);
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

      await expect(
        service.updatePageContent(DOC_ID, {
          content: 'abc\u0000def',
          expectedRev: 5,
        }),
      ).rejects.toThrow(BadRequestException);

      await expect(
        service.updatePageContent(DOC_ID, {
          content: 'stale edit',
          expectedRev: 2,
        }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('Root document page isolation & metadata-only catalog', () => {
    it('prevents cross-page content hijack when rootDocId is null and preserves .tex filenames on dotted display titles', async () => {
      const pageFindFirst = jest.fn();
      const resolved = await findPageRecordWithNode(
        {
          pageDoc: { findFirst: jest.fn().mockResolvedValue(null) },
          page: {
            findUnique: jest.fn().mockResolvedValue({
              id: PAGE_ID,
              spaceId: SPACE_ID,
              rootDocId: null,
              deletedAt: null,
            }),
            findFirst: pageFindFirst,
          },
        } as unknown as PrismaService,
        PAGE_ID,
        SPACE_ID,
      );
      expect(resolved).toBeNull();
      expect(pageFindFirst).not.toHaveBeenCalled();

      const pageNodeUpdateMany = jest.fn();
      const pageDocUpdate = jest.fn();
      const pageUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
      await applyPageMetadataAndTitleUpdates(
        {
          pageNode: { updateMany: pageNodeUpdateMany },
          pageDoc: { update: pageDocUpdate },
          page: { updateMany: pageUpdateMany },
        } as unknown as PrismaService,
        DOC_ID,
        { spaceId: SPACE_ID, lastKnownPath: 'main.tex', ranges: {} },
        { title: 'Draft v1.2' },
      );

      expect(pageNodeUpdateMany).not.toHaveBeenCalled();
      expect(pageDocUpdate).not.toHaveBeenCalled();
      expect(pageUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { title: 'Draft v1.2' } }),
      );
    });

    it('updates Page metadata and lists space Pages without hydrating PageDoc.lines or flushing Yjs', async () => {
      const now = new Date('2026-07-01T00:00:00Z');
      const updateDocMock = jest.fn();
      const getDocMock = jest.fn();
      const flushDocsMock = jest.fn();

      const mockPrisma = {
        page: {
          findFirst: jest.fn().mockResolvedValue({
            id: PAGE_ID,
            spaceId: SPACE_ID,
            title: 'Old Title',
            description: 'Old Desc',
            status: 'draft',
            compiler: 'pdflatex',
            texlive: '2025',
            spellLang: 'en_US',
            rootDocId: DOC_ID,
            deletedAt: null,
          }),
          findMany: jest.fn().mockResolvedValue([
            {
              id: PAGE_ID,
              spaceId: SPACE_ID,
              title: 'Draft v1.2',
              description: 'Updated',
              status: 'published',
              compiler: 'xelatex',
              texlive: '2025',
              spellLang: 'fr_FR',
              rootDocId: DOC_ID,
              thumbnail: null,
              createdById: null,
              labels: [
                { label: { id: 'lbl-1', name: 'ICML', color: '#2563eb' } },
              ],
              rootDoc: {
                id: DOC_ID,
                lastKnownPath: 'main.tex',
                version: 4,
                rev: 9,
              },
              createdAt: now,
              updatedAt: now,
            },
          ]),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        pageDoc: {
          findFirst: jest.fn().mockResolvedValue({ id: DOC_ID }),
          findMany: jest.fn(),
        },
        pageNode: { updateMany: jest.fn() },
        pageLabel: {
          deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
          findMany: jest.fn().mockResolvedValue([]),
        },
      } as unknown as PrismaService;

      const service = new PageService(
        mockPrisma,
        {
          updateDoc: updateDocMock,
          getDoc: getDocMock,
        } as unknown as DocstoreService,
        {} as PageScaffoldService,
        undefined,
        { applyExternalText: jest.fn(), flushDocs: flushDocsMock } as never,
      );

      const metaRes = await service.updatePageMetadata(
        PAGE_ID,
        {
          title: 'Draft v1.2',
          compiler: 'xelatex',
          texlive: '2025',
          spellLang: 'fr_FR',
          rootDocId: DOC_ID,
        },
        SPACE_ID,
      );
      expect(metaRes.page.compiler).toBe('xelatex');
      expect(metaRes.page.spellLang).toBe('fr_FR');

      const listRes = await service.getProjectPages(SPACE_ID);
      expect(listRes.pages).toHaveLength(1);
      expect(listRes.pages[0].title).toBe('Draft v1.2');
      expect(listRes.pages[0].labels).toHaveLength(1);
      expect(updateDocMock).not.toHaveBeenCalled();
      expect(getDocMock).not.toHaveBeenCalled();
      expect(flushDocsMock).not.toHaveBeenCalled();

      await expect(
        service.removePageLabel(SPACE_ID, PAGE_ID, 'lbl-1'),
      ).resolves.toEqual({ labels: [] });
    });
  });
});
