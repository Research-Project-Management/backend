import { NotFoundException } from '@nestjs/common';
import { ManuscriptPageService } from '@/modules/manuscripts/core/services/manuscript-page.service';
import { PagesDocController } from '@/modules/manuscripts/docstore/controllers/pages-doc.controller';
import { ManuscriptProjectBootstrapService } from '@/modules/manuscripts/docstore/services/manuscript-project-bootstrap.service';
import { ManuscriptPageScopeRepository } from '@/modules/manuscripts/docstore/repositories/manuscript-page-scope.repository';

describe('ManuscriptPageService & Thin Controller Delegation', () => {
  let pageService: ManuscriptPageService;
  let projectBootstrapService: ManuscriptProjectBootstrapService;
  let pageScopeRepo: ManuscriptPageScopeRepository;
  let mockPrisma: any;
  let mockDocstore: any;
  let mockEventEmitter: any;

  const projectId = '01928374-0001-7000-8000-000000000001';
  const pageId = '01928374-0002-7000-8000-000000000002';
  const userId = '01928374-0003-7000-8000-000000000003';

  beforeEach(() => {
    mockPrisma = {
      project: {
        findUnique: jest.fn().mockResolvedValue({
          id: projectId,
          name: 'Quantum Project',
          settings: {},
          createdBy: {
            id: userId,
            email: 'researcher@example.com',
            profile: { name: 'Lead Researcher' },
          },
        }),
        update: jest.fn().mockResolvedValue({ id: projectId }),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: userId,
          email: 'researcher@example.com',
          profile: { name: 'Lead Researcher' },
        }),
      },
      manuscriptPage: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
        deleteMany: jest.fn(),
      },
      manuscriptDoc: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      manuscriptNode: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
        deleteMany: jest.fn(),
      },
      manuscriptFile: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      manuscriptPageLabel: {
        findMany: jest.fn(),
        create: jest.fn(),
        deleteMany: jest.fn(),
      },
      label: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      workItemLabel: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      $transaction: jest.fn(async (cb: any) => {
        if (typeof cb === 'function') {
          return cb(mockPrisma);
        }
        return Promise.all(cb);
      }),
    };

    mockDocstore = {
      getDoc: jest.fn(),
      updateDoc: jest.fn(),
      patchDoc: jest.fn().mockResolvedValue({ ok: true }),
      createDoc: jest.fn().mockImplementation((projId: string, payload: any) =>
        Promise.resolve({
          _id: payload.id || pageId,
          projectId: projId,
          path: payload.path,
          lines: (payload.text || '').split('\n'),
          version: payload.version || 1,
          rev: 0,
        }),
      ),
      readFromStorage: jest.fn(),
    };

    mockEventEmitter = {
      emit: jest.fn(),
    };

    projectBootstrapService = new ManuscriptProjectBootstrapService(
      mockPrisma,
      mockDocstore,
    );

    pageScopeRepo = new ManuscriptPageScopeRepository(mockPrisma);

    pageService = new ManuscriptPageService(
      mockPrisma,
      mockDocstore,
      projectBootstrapService,
      mockEventEmitter,
      undefined,
      pageScopeRepo,
    );
  });

  describe('Page Creation & Backward-Compatibility Invariant', () => {
    it('ensures page.id === rootDoc.id for 100% backward compatibility', async () => {
      mockPrisma.manuscriptNode.create.mockImplementation(({ data }: any) => ({
        id: 'node-1',
        ...data,
      }));

      const created = await pageService.createProjectPage(
        projectId,
        {
          title: 'Quantum Field Theory Notes',
          content: 'Initial paragraph of manuscript page',
        },
        userId,
      );

      expect(created).toBeDefined();
      expect(created.page).toBeDefined();
      expect(created.mainFile).toBeDefined();

      // Core invariant: page.id must strictly equal rootDoc.id (mainFile.id)
      expect(created.page.id).toBe(created.mainFile.id);
      expect(created.page.rootPageId).toBe(created.page.id);
      expect(created.page.mainFileId).toBe(created.page.id);

      // Verifies Docstore createDoc and node creation
      expect(mockDocstore.createDoc).toHaveBeenCalledWith(
        projectId,
        expect.objectContaining({
          path: '/main.tex',
          text: 'Initial paragraph of manuscript page',
        }),
      );
      expect(mockPrisma.manuscriptNode.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            projectId,
            name: 'main.tex',
            docId: created.page.id,
            isRootDoc: true,
          }),
        }),
      );
    });

    it('creates page with template preservation and backward compatibility', async () => {
      mockPrisma.manuscriptNode.create.mockImplementation(({ data }: any) => ({
        id: 'node-custom',
        ...data,
      }));

      const created = await pageService.createProjectPage(
        projectId,
        {
          title: 'Example Project',
          templateType: 'example',
        },
        userId,
      );

      expect(created.page.id).toBe(pageId);
      expect(created.mainFile.id).toBe(pageId);
      expect(created.rootPageId).toBe(pageId);
      expect(created.page.content).toContain('\\documentclass{article}');
    });
  });

  describe('Page Queries & Aggregate Lifecycle', () => {
    it('retrieves page aggregate with its rootDoc and files', async () => {
      mockPrisma.manuscriptDoc.findFirst.mockResolvedValue({
        id: pageId,
        projectId,
        path: 'main.tex',
        lines: ['\\section{Intro}'],
        version: 1,
        rev: 0,
        deleted: false,
        ranges: {},
        node: {
          id: 'node-root',
          name: 'My Research Page',
          path: '/main.tex',
        },
      });

      const page = await pageService.getPageById(pageId, projectId);
      expect(page).toBeDefined();
      expect(page.id).toBe(pageId);
      expect(page.page.title).toBe('My Research Page');
      expect(page.page.content).toBe('\\section{Intro}');
      expect(mockPrisma.manuscriptDoc.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            projectId,
            deleted: false,
          }),
        }),
      );
    });

    it('throws NotFoundException if page is not found in the project', async () => {
      mockPrisma.manuscriptDoc.findFirst.mockResolvedValue(null);

      await expect(
        pageService.getPageById('01928374-9999-7000-8000-000000000099', projectId),
      ).rejects.toThrow(NotFoundException);
    });

    it('lists non-archived project pages', async () => {
      const now = new Date();
      mockPrisma.manuscriptNode.findMany.mockResolvedValue([
        {
          id: 'node-1',
          name: 'Page 1',
          docId: '01928374-0002-7000-8000-000000000001',
          isRootDoc: true,
          createdAt: now,
          updatedAt: now,
          doc: {
            id: '01928374-0002-7000-8000-000000000001',
            projectId,
            path: 'main.tex',
            lines: ['Line 1'],
            deleted: false,
            createdAt: now,
            updatedAt: now,
          },
        },
        {
          id: 'node-2',
          name: 'Page 2',
          docId: '01928374-0002-7000-8000-000000000002',
          isRootDoc: true,
          createdAt: now,
          updatedAt: now,
          doc: {
            id: '01928374-0002-7000-8000-000000000002',
            projectId,
            path: 'page2.tex',
            lines: ['Line 2'],
            deleted: false,
            createdAt: now,
            updatedAt: now,
          },
        },
      ]);

      const result = await pageService.getProjectPages(projectId);
      expect(result.pages).toHaveLength(2);
      expect(result.pages[0].id).toBe('01928374-0002-7000-8000-000000000001');
      expect(result.total).toBe(2);
      expect(mockPrisma.manuscriptNode.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ projectId, isRootDoc: true }),
        }),
      );
    });

    it('updates thumbnail for a page aggregate', async () => {
      mockPrisma.manuscriptDoc.findFirst.mockResolvedValue({
        id: pageId,
        projectId,
        ranges: {},
      });
      mockPrisma.manuscriptDoc.update.mockResolvedValue({
        id: pageId,
        ranges: { pdfThumbnail: 'https://cdn.example.com/thumb.png' },
      });

      const updated = await pageService.updateThumbnail(
        pageId,
        'https://cdn.example.com/thumb.png',
        projectId,
      );
      expect(updated.page.pdfThumbnail).toBe('https://cdn.example.com/thumb.png');
      expect(mockPrisma.manuscriptDoc.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: pageId },
          data: expect.objectContaining({
            ranges: expect.objectContaining({
              pdfThumbnail: 'https://cdn.example.com/thumb.png',
            }),
          }),
        }),
      );
    });

    it('soft deletes page and its rootDoc', async () => {
      mockPrisma.manuscriptDoc.findFirst.mockResolvedValue({
        id: pageId,
        projectId,
      });

      const deleted = await pageService.deletePage(pageId, projectId);
      expect(deleted.success).toBe(true);

      expect(mockDocstore.patchDoc).toHaveBeenCalledWith(
        projectId,
        pageId,
        expect.objectContaining({ deleted: true }),
      );
      expect(mockPrisma.manuscriptNode.deleteMany).toHaveBeenCalledWith({
        where: {
          projectId,
          OR: [{ docId: pageId }, { id: pageId }],
        },
      });
    });

    it('restores soft-deleted page', async () => {
      mockPrisma.manuscriptDoc.findFirst.mockResolvedValue({
        id: pageId,
        projectId,
        path: 'main.tex',
        lines: ['Restored line'],
        deleted: true,
      });
      mockPrisma.manuscriptNode.findFirst.mockResolvedValue(null);
      mockPrisma.manuscriptNode.create.mockResolvedValue({
        id: 'restored-node',
        projectId,
        name: 'main.tex',
        path: '/main.tex',
      });

      const restored = await pageService.restorePage(pageId, projectId);
      expect(restored.success).toBe(true);
      expect(restored.page.id).toBe(pageId);

      expect(mockDocstore.patchDoc).toHaveBeenCalledWith(
        projectId,
        pageId,
        expect.objectContaining({ deleted: false }),
      );
    });

    it('duplicates page aggregate and rootDoc preserving consistency', async () => {
      const clonedId = '01928374-0099-7000-8000-000000000099';
      mockPrisma.manuscriptDoc.findFirst.mockResolvedValue({
        id: pageId,
        projectId,
        path: 'Original Analysis.tex',
        lines: ['Line 1', 'Line 2'],
        sizeBytes: 150,
        hash: 'hash-abc',
        version: 1,
        rev: 2,
        ranges: { theme: 'academic' },
      });

      mockPrisma.manuscriptDoc.create.mockResolvedValue({
        id: clonedId,
        projectId,
        path: 'Original Analysis.tex (Copy)',
        lines: ['Line 1', 'Line 2'],
        sizeBytes: 150,
        hash: 'hash-abc',
        version: 1,
        rev: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      mockPrisma.manuscriptNode.findFirst.mockResolvedValue({
        id: 'node-src',
        projectId,
        name: 'Original Analysis.tex',
        path: '/Original Analysis.tex',
        depth: 0,
        docId: pageId,
        isRootDoc: true,
        sortOrder: 1,
        type: 'DOC',
      });

      mockPrisma.manuscriptNode.create.mockResolvedValue({
        id: 'node-clone',
        projectId,
        name: 'Original Analysis.tex (Copy)',
        path: '/Original Analysis.tex (Copy)',
        docId: clonedId,
      });

      const cloned = await pageService.duplicatePage(pageId, projectId);
      expect(cloned).toBeDefined();
      expect(cloned.page.title).toContain('(Copy)');
      expect(cloned.page.id).not.toBe(pageId);
      expect(cloned.page.id).toBe(clonedId);
      expect(cloned.rootPageId).toBe(clonedId); // Maintains page.id === rootDoc.id invariant!
      expect(cloned.mainFileId).toBe(clonedId);
    });
  });

  describe('PagesDocController Thin Delegation', () => {
    let controller: PagesDocController;

    beforeEach(() => {
      controller = new PagesDocController(pageService, mockDocstore);
    });

    it('delegates createProjectPage directly to ManuscriptPageService', async () => {
      const createSpy = jest
        .spyOn(pageService, 'createProjectPage')
        .mockResolvedValue({
          page: {
            id: 'new-id',
            title: 'Chapter1.tex',
            projectId,
          },
          mainFile: { id: 'new-id', title: 'Chapter1.tex' },
          rootPageId: 'new-id',
          mainFileId: 'new-id',
        } as any);

      const req = {
        user: { id: userId },
      } as any;

      const res = await controller.createProjectPage(
        projectId,
        {
          title: 'Chapter1.tex',
          content: 'Hello World',
        },
        req,
      );

      expect(createSpy).toHaveBeenCalledWith(
        projectId,
        {
          title: 'Chapter1.tex',
          content: 'Hello World',
        },
        userId,
      );
      expect(res).toBeDefined();
      expect(res.page).toBeDefined();
      expect(res.page.projectId).toBe(projectId);
    });

    it('delegates duplicatePage directly to ManuscriptPageService', async () => {
      const duplicateSpy = jest
        .spyOn(pageService, 'duplicatePage')
        .mockResolvedValue({
          page: { id: 'dup-id', title: 'Copy' },
          mainFile: { id: 'dup-id', title: 'Copy' },
          rootPageId: 'dup-id',
          mainFileId: 'dup-id',
        } as any);

      const res = await controller.duplicatePage(pageId, projectId);

      expect(duplicateSpy).toHaveBeenCalledWith(pageId, projectId);
      expect(res.page.id).toBe('dup-id');
    });

    it('delegates deletePage directly to ManuscriptPageService', async () => {
      const deleteSpy = jest
        .spyOn(pageService, 'deletePage')
        .mockResolvedValue({ success: true });

      const res = await controller.deletePage(pageId, projectId);
      expect(deleteSpy).toHaveBeenCalledWith(pageId, projectId);
      expect(res.success).toBe(true);
    });
  });
});
