import {
  InvalidTemplateError,
  TemplateForbiddenError,
  TemplateNotFoundError,
} from '@/modules/pages/templates/domain/errors';
import { BUILTIN_TEMPLATES } from '@/modules/pages/templates/domain/catalog.domain';
import { TemplateFileVo } from '@/modules/pages/templates/domain/file.domain';
import { TemplateManifest } from '@/modules/pages/templates/domain/manifest.domain';
import {
  TEMPLATE_CATEGORIES,
  TEMPLATE_SCOPES,
  assertCategory,
  assertScope,
  canManageTemplate,
  canReadTemplate,
} from '@/modules/pages/templates/domain/policy';
import { GalleryService } from '@/modules/pages/templates/services/gallery.service';
import { InstantiateService } from '@/modules/pages/templates/services/instantiate.service';
import { PublishService } from '@/modules/pages/templates/services/publish.service';

const USER_ALICE = '11111111-1111-4111-8111-111111111111';
const USER_BOB = '22222222-2222-4222-8222-222222222222';
const SPACE_PROJECT = '33333333-3333-4333-8333-333333333333';
const PAGE_SOURCE = '44444444-4444-4444-8444-444444444444';
const BLOB_LOGO = '77777777-7777-4777-8777-777777777777';

describe('Templates Module (Flux Space + Zero-Copy FileBlob + ACID Batch Clone)', () => {
  describe('1. Zero-Copy File Value Object & Batch Clone Plan (`file.domain.ts`, `manifest.domain.ts`)', () => {
    it('hashes DOC text deterministically and links FILE binary assets via FileBlob without BYTEA buffers', () => {
      const texA = TemplateFileVo.fromText(
        'main.tex',
        '\\documentclass{article}\r\n\\begin{document}Hi\\end{document}',
      );
      const texB = TemplateFileVo.fromText(
        '/main.tex',
        '\\documentclass{article}\n\\begin{document}Hi\\end{document}',
      );

      expect(texA.path).toBe('main.tex');
      expect(texA.type).toBe('DOC');
      expect(texA.contentHash).toHaveLength(64);
      expect(texA.contentHash).toBe(texB.contentHash);

      const logo = TemplateFileVo.fromAssetRef('figures/logo.png', {
        blobId: BLOB_LOGO,
        storageKey: 'cas/ab/cd/logo.png',
        bucketName: 'manuscript-files',
        contentHash: 'a'.repeat(64),
        mimeType: 'image/png',
        sizeBytes: 4096,
      });
      expect(logo.type).toBe('FILE');
      expect(logo.blobId).toBe(BLOB_LOGO);
      expect(logo.textContent).toBeNull();
      expect('content' in logo.toView()).toBe(false);

      expect(() => TemplateFileVo.fromText('../etc/passwd', 'bad')).toThrow(
        InvalidTemplateError,
      );
      expect(() => assertCategory('resume')).toThrow(InvalidTemplateError);
    });

    it('builds an O(1) batch Page clone plan with rootDocId===pageId, depth-ordered folders, and FileBlob increments', () => {
      const tex = TemplateFileVo.fromText(
        'paper.tex',
        '\\documentclass[conference]{IEEEtran}\n\\begin{document}Hello\\end{document}',
      );
      const png = TemplateFileVo.fromAssetRef('assets/plots/fig1.png', {
        blobId: BLOB_LOGO,
        storageKey: 'cas/fig1.png',
        contentHash: 'b'.repeat(64),
        mimeType: 'image/png',
        sizeBytes: 2048,
      });

      const manifest = TemplateManifest.create({
        name: 'IEEE Conference Paper',
        category: 'conference',
        compiler: 'xelatex',
        texlive: '2025',
        mainFile: 'paper.tex',
        spaceId: SPACE_PROJECT,
        spaceType: 'project',
        tags: ['IEEE', 'Conference', 'ieee'],
        files: [tex, png],
      });

      expect(manifest.scope).toBe('project');
      expect(manifest.isCustom).toBe(true);
      expect(manifest.tags).toEqual(['ieee', 'conference']);

      const summary = manifest.toSummary();
      expect(summary.fileCount).toBe(2);
      expect('files' in summary).toBe(false);

      const plan = manifest.buildPageClonePlan({
        spaceId: SPACE_PROJECT,
        customTitle: 'Cloned Paper',
      });
      expect(plan.title).toBe('Cloned Paper');
      expect(plan.rootDocId).toBe(plan.pageId);
      expect(plan.compiler).toBe('xelatex');
      expect(plan.texlive).toBe('2025');
      expect(plan.docsToCreate).toHaveLength(1);
      expect(plan.filesToCreate).toHaveLength(1);
      expect(plan.blobIncrements.get(BLOB_LOGO)).toBe(1);
      // Depth 1 (`paper.tex` + `/assets`), Depth 2 (`/assets/plots`), Depth 3 (`fig1.png`)
      expect(plan.nodeBatchesByDepth.get(1)).toHaveLength(2);
      expect(plan.nodeBatchesByDepth.get(2)).toHaveLength(1);
      expect(plan.nodeBatchesByDepth.get(3)).toHaveLength(1);
    });
  });

  describe('2. Flyweight Built-in Preset Catalog (`catalog.domain.ts`)', () => {
    it('defines 13 curated built-in academic presets (`isCustom === false`, `scope === null`, `texlive === "2025"`)', () => {
      expect(TEMPLATE_CATEGORIES).toHaveLength(11);
      expect(TEMPLATE_SCOPES).toEqual(['personal', 'project']);
      expect(BUILTIN_TEMPLATES).toHaveLength(13);
      for (const tmpl of BUILTIN_TEMPLATES) {
        expect(tmpl.spaceId).toBeNull();
        expect(tmpl.scope).toBeNull();
        expect(tmpl.isCustom).toBe(false);
        expect(tmpl.texlive).toBe('2025');
      }
    });
  });

  describe('3. Space & Role RBAC (`GalleryService`)', () => {
    it('enforces Flux Space (`personal` | `project`) and ProjectMember Role rules', async () => {
      expect(
        canReadTemplate({
          spaceId: USER_ALICE,
          userId: USER_BOB,
          memberRole: null,
        }),
      ).toBe(false);

      expect(
        canManageTemplate({
          spaceId: null,
          createdById: null,
          userId: USER_ALICE,
          memberRole: null,
        }),
      ).toBe(false);

      const personalByAlice = TemplateManifest.create({
        id: '55555555-5555-4555-8555-555555555555',
        name: 'Alice Personal Template',
        spaceId: USER_ALICE,
        spaceType: 'personal',
        createdById: USER_ALICE,
        files: [
          TemplateFileVo.fromText('main.tex', '\\documentclass{article}'),
        ],
      });

      const mockRepo = {
        findSummaries: jest
          .fn()
          .mockResolvedValue({ items: [personalByAlice], total: 1 }),
        findDetail: jest.fn().mockResolvedValue(personalByAlice),
        save: jest.fn(),
        deleteById: jest
          .fn()
          .mockResolvedValue({ deleted: true, releasedBlobIds: [BLOB_LOGO] }),
      };
      const mockAccess = {
        getRole: jest.fn().mockResolvedValue(null),
      };
      const mockFilesPort = {
        releaseBlob: jest.fn().mockResolvedValue({}),
      };

      const gallery = new GalleryService(
        mockRepo as never,
        mockAccess as never,
        mockFilesPort as never,
      );

      // Built-in templates resolve in O(1) memory without hitting DB
      const builtinDetail = await gallery.getDetail(
        'ieee-transactions',
        USER_BOB,
      );
      expect(builtinDetail.isCustom).toBe(false);
      expect(mockRepo.findDetail).not.toHaveBeenCalled();

      await expect(
        gallery.remove('ieee-transactions', USER_ALICE),
      ).rejects.toThrow(TemplateForbiddenError);

      await expect(
        gallery.getDetail(personalByAlice.id, USER_BOB),
      ).rejects.toThrow(TemplateNotFoundError);

      const detail = await gallery.getDetail(personalByAlice.id, USER_ALICE);
      expect(detail.scope).toBe('personal');
      expect(detail.isCustom).toBe(true);

      await expect(gallery.remove(personalByAlice.id, USER_BOB)).rejects.toThrow(
        TemplateForbiddenError,
      );
      await gallery.remove(personalByAlice.id, USER_ALICE);
      expect(mockRepo.deleteById).toHaveBeenCalledWith(personalByAlice.id);
      expect(mockFilesPort.releaseBlob).toHaveBeenCalledWith(BLOB_LOGO);
    });
  });

  describe('4. Zero-Copy Publisher & Idempotent Republisher (`PublishService`)', () => {
    it('snapshots PageDoc + PageFile FileBlob refs and updates in-place on republish', async () => {
      let storedManifest: TemplateManifest | null = null;

      const prisma = {
        space: { upsert: jest.fn().mockResolvedValue({}) },
        page: {
          findFirst: jest.fn().mockResolvedValue({
            id: PAGE_SOURCE,
            spaceId: SPACE_PROJECT,
            description: 'Lab template',
            compiler: 'lualatex',
            texlive: '2025',
            thumbnail: 'https://cdn.flux/thumb.png',
            rootDoc: { lastKnownPath: '/paper.tex' },
          }),
        },
        pageNode: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'n1',
              path: '/paper.tex',
              name: 'paper.tex',
              type: 'DOC',
              docId: 'd1',
              depth: 1,
            },
            {
              id: 'n2',
              path: '/figs/plot.png',
              name: 'plot.png',
              type: 'FILE',
              fileId: 'f1',
              depth: 2,
            },
          ]),
        },
        pageDoc: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'd1',
              inStorage: false,
              lines: [
                '\\documentclass{article}',
                '\\begin{document}Hi\\end{document}',
              ],
            },
          ]),
        },
        pageFile: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'f1',
              blobId: BLOB_LOGO,
              storageKey: 'cas/plot.png',
              bucketName: 'manuscript-files',
              hash: 'c'.repeat(64),
              mimeType: 'image/png',
              sizeBytes: 8192,
            },
          ]),
        },
      };

      const repo = {
        findBySourcePage: jest.fn(async () => storedManifest),
        save: jest.fn(async (m: TemplateManifest) => {
          storedManifest = m;
          return m;
        }),
      };
      const gallery = {
        getSpaceRole: jest.fn().mockResolvedValue('contributor'),
        assertCanManage: jest.fn().mockResolvedValue(undefined),
      };
      const filesPort = {
        acquireBlob: jest.fn().mockResolvedValue({}),
      };

      const publisher = new PublishService(
        prisma as never,
        repo as never,
        gallery as never,
        {} as never,
        filesPort as never,
      );

      expect(() => assertScope('workspace')).toThrow(InvalidTemplateError);

      const first = await publisher.publish(USER_ALICE, {
        pageId: PAGE_SOURCE,
        name: 'Lab Paper Template',
        category: 'journal',
        scope: 'project',
      });

      expect(first.scope).toBe('project');
      expect(first.spaceId).toBe(SPACE_PROJECT);
      expect(first.sourcePageId).toBe(PAGE_SOURCE);
      expect(first.compiler).toBe('lualatex');
      expect(first.texlive).toBe('2025');
      expect(first.fileCount).toBe(2);
      expect(filesPort.acquireBlob).toHaveBeenCalledWith(BLOB_LOGO);

      // Republishing the same sourcePageId into the same Space updates in-place (same template ID)
      const second = await publisher.publish(USER_ALICE, {
        pageId: PAGE_SOURCE,
        name: 'Lab Paper Template v2',
        category: 'journal',
        scope: 'project',
      });
      expect(second.id).toBe(first.id);
      expect(second.name).toBe('Lab Paper Template v2');
    });
  });

  describe('5. Single-Transaction ACID Batch Instantiator (`InstantiateService`)', () => {
    it('clones Page + PageDoc + PageFile + PageNode atomically in one $transaction and acquires FileBlobs', async () => {
      const proto = TemplateManifest.create({
        id: '66666666-6666-4666-8666-666666666666',
        slug: 'xelatex-thesis',
        name: 'XeLaTeX Thesis',
        category: 'thesis',
        compiler: 'xelatex',
        texlive: '2025',
        mainFile: 'thesis.tex',
        files: [
          TemplateFileVo.fromText(
            'thesis.tex',
            '\\documentclass{report}\n\\begin{document}Thesis\\end{document}',
          ),
          TemplateFileVo.fromAssetRef('images/seal.png', {
            blobId: BLOB_LOGO,
            storageKey: 'cas/seal.png',
            contentHash: 'd'.repeat(64),
            mimeType: 'image/png',
            sizeBytes: 1024,
          }),
        ],
      });

      const txMock = {
        space: { upsert: jest.fn().mockResolvedValue({}) },
        page: {
          create: jest.fn().mockResolvedValue({}),
          update: jest.fn().mockResolvedValue({}),
        },
        pageDoc: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
        pageFile: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
        pageNode: { createMany: jest.fn().mockResolvedValue({ count: 2 }) },
      };

      const prisma = {
        $transaction: jest.fn(async (cb: (tx: typeof txMock) => Promise<void>) =>
          cb(txMock),
        ),
      };
      const gallery = {
        getAuthorizedManifest: jest.fn().mockResolvedValue(proto),
      };
      const filesPort = {
        acquireBlob: jest.fn().mockResolvedValue({}),
      };
      const eventEmitter = {
        emit: jest.fn(),
      };

      const instantiator = new InstantiateService(
        prisma as never,
        gallery as never,
        filesPort as never,
        eventEmitter as never,
      );

      const res = await instantiator.instantiate(
        USER_ALICE,
        'xelatex-thesis',
        USER_ALICE,
        { title: 'My PhD Thesis' },
      );

      expect(res.isPersonal).toBe(true);
      expect(res.compiler).toBe('xelatex');
      expect(res.texlive).toBe('2025');
      expect(res.rootDocId).toBe(res.pageId);
      expect(res.createdDocs).toBe(1);
      expect(res.createdFiles).toBe(1);
      expect(txMock.pageDoc.createMany).toHaveBeenCalledTimes(1);
      expect(txMock.pageFile.createMany).toHaveBeenCalledTimes(1);
      expect(filesPort.acquireBlob).toHaveBeenCalledWith(BLOB_LOGO);
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'pages.file-tree.change',
        expect.objectContaining({
          projectId: USER_ALICE,
        }),
      );
    });
  });
});
