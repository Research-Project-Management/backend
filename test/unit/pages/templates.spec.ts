import {
  BUILTIN_TEMPLATES,
  GalleryService,
  InstantiateService,
  InvalidTemplateError,
  PublishService,
  TEMPLATE_CATEGORIES,
  TEMPLATE_SCOPES,
  TemplateFileVo,
  TemplateForbiddenError,
  TemplateManifest,
  TemplateNotFoundError,
  assertCategory,
  assertScope,
  canManageTemplate,
  canReadTemplate,
} from '@/modules/pages/templates';
import { TemplatesRepository } from '@/modules/pages/templates/templates.repository';

const USER_ALICE = '11111111-1111-4111-8111-111111111111';
const USER_BOB = '22222222-2222-4222-8222-222222222222';
const SPACE_PROJECT = '33333333-3333-4333-8333-333333333333';
const PAGE_SOURCE = '44444444-4444-4444-8444-444444444444';
const BLOB_LOGO = '77777777-7777-4777-8777-777777777777';

describe('Pages Templates Seam', () => {
  describe('TemplateFileVo, TemplateManifest & built-in catalog', () => {
    it('hashes normalized DOC text, references binary assets by FileBlob ID, and builds depth-ordered clone plans', () => {
      const texA = TemplateFileVo.fromText(
        'main.tex',
        '\\documentclass{article}\r\n\\begin{document}Hi\\end{document}',
      );
      const texB = TemplateFileVo.fromText(
        '/main.tex',
        '\\documentclass{article}\n\\begin{document}Hi\\end{document}',
      );
      expect(texA.path).toBe('main.tex');
      expect(texA.contentHash).toBe(texB.contentHash);

      const logo = TemplateFileVo.fromAssetRef('assets/plots/logo.png', {
        blobId: BLOB_LOGO,
        storageKey: 'cas/ab/cd/logo.png',
        bucketName: 'manuscript-files',
        contentHash: 'a'.repeat(64),
        mimeType: 'image/png',
        sizeBytes: 4096,
      });
      expect(logo.type).toBe('FILE');
      expect(logo.blobId).toBe(BLOB_LOGO);
      expect('content' in logo.toView()).toBe(false);

      expect(() => TemplateFileVo.fromText('../etc/passwd', 'bad')).toThrow(
        InvalidTemplateError,
      );
      expect(() => assertCategory('resume')).toThrow(InvalidTemplateError);

      const manifest = TemplateManifest.create({
        name: 'IEEE Conference Paper',
        category: 'conference',
        compiler: 'xelatex',
        texlive: '2025',
        mainFile: 'main.tex',
        spaceId: SPACE_PROJECT,
        spaceType: 'project',
        tags: ['IEEE', 'Conference', 'ieee'],
        files: [texA, logo],
      });
      expect(manifest.tags).toEqual(['ieee', 'conference']);
      expect(manifest.toSummary().fileCount).toBe(2);

      const plan = manifest.buildPageClonePlan({
        spaceId: SPACE_PROJECT,
        customTitle: 'Cloned Paper',
      });
      expect(plan.title).toBe('Cloned Paper');
      expect(plan.rootDocId).toBe(plan.pageId);
      expect(plan.blobIncrements.get(BLOB_LOGO)).toBe(1);
      expect(plan.nodeBatchesByDepth.get(1)).toHaveLength(2);
      expect(plan.nodeBatchesByDepth.get(2)).toHaveLength(1);
      expect(plan.nodeBatchesByDepth.get(3)).toHaveLength(1);
    });

    it('provides 13 immutable built-in academic presets', () => {
      expect(TEMPLATE_CATEGORIES).toHaveLength(11);
      expect(TEMPLATE_SCOPES).toEqual(['personal', 'project']);
      expect(BUILTIN_TEMPLATES).toHaveLength(13);
      for (const tmpl of BUILTIN_TEMPLATES) {
        expect(tmpl.isCustom).toBe(false);
        expect(tmpl.scope).toBeNull();
        expect(tmpl.texlive).toBe('2025');
      }
    });
  });

  describe('GalleryService RBAC, PublishService CAS deduplication & InstantiateService', () => {
    it('enforces personal/project Space RBAC and releases FileBlobs when deleting custom templates', async () => {
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

      const findDetail = jest.fn().mockResolvedValue(personalByAlice);
      const releaseBlob = jest.fn().mockResolvedValue({});
      const gallery = new GalleryService(
        {
          findSummaries: jest
            .fn()
            .mockResolvedValue({ items: [personalByAlice], total: 1 }),
          findDetail,
          deleteById: jest.fn().mockResolvedValue({
            deleted: true,
            releasedBlobIds: [BLOB_LOGO],
          }),
        } as never,
        { getRole: jest.fn().mockResolvedValue(null) } as never,
        { releaseBlob } as never,
      );

      expect(
        (await gallery.getDetail('ieee-transactions', USER_BOB)).isCustom,
      ).toBe(false);
      expect(findDetail).not.toHaveBeenCalled();

      await expect(
        gallery.remove('ieee-transactions', USER_ALICE),
      ).rejects.toThrow(TemplateForbiddenError);
      await expect(
        gallery.getDetail(personalByAlice.id, USER_BOB),
      ).rejects.toThrow(TemplateNotFoundError);
      await expect(
        gallery.remove(personalByAlice.id, USER_BOB),
      ).rejects.toThrow(TemplateForbiddenError);

      await gallery.remove(personalByAlice.id, USER_ALICE);
      expect(releaseBlob).toHaveBeenCalledWith(BLOB_LOGO);
    });

    it('republishes in-place for the same sourcePageId and deduplicates FileBlob acquisition across shared TemplateBlobs', async () => {
      let storedManifest: TemplateManifest | null = null;
      const acquireBlob = jest.fn().mockResolvedValue({});

      const publisher = new PublishService(
        {
          space: { upsert: jest.fn().mockResolvedValue({}) },
          page: {
            findFirst: jest.fn().mockResolvedValue({
              id: PAGE_SOURCE,
              spaceId: SPACE_PROJECT,
              description: 'Lab template',
              compiler: 'lualatex',
              texlive: '2025',
              thumbnail: null,
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
        } as never,
        {
          findBySourcePage: jest.fn(async () => storedManifest),
          save: jest.fn(async (m: TemplateManifest) => {
            storedManifest = m;
            return m;
          }),
        } as never,
        {
          getSpaceRole: jest.fn().mockResolvedValue('contributor'),
          assertCanManage: jest.fn().mockResolvedValue(undefined),
        } as never,
        {} as never,
        { acquireBlob } as never,
      );

      expect(() => assertScope('workspace')).toThrow(InvalidTemplateError);

      const first = await publisher.publish(USER_ALICE, {
        pageId: PAGE_SOURCE,
        name: 'Lab Paper Template',
        category: 'journal',
        scope: 'project',
      });
      const second = await publisher.publish(USER_ALICE, {
        pageId: PAGE_SOURCE,
        name: 'Lab Paper Template v2',
        category: 'journal',
        scope: 'project',
      });

      expect(second.id).toBe(first.id);
      expect(second.name).toBe('Lab Paper Template v2');
      expect(acquireBlob).toHaveBeenCalledWith(BLOB_LOGO);

      // Shared TemplateBlob CAS deduplication across templates
      const existingBlobHashes = new Set<string>();
      const txMock = {
        templateBlob: {
          findMany: jest.fn(
            async ({ where }: { where: Record<string, unknown> }) => {
              if ('contentHash' in where) {
                return (where.contentHash as { in: string[] }).in
                  .filter((h) => existingBlobHashes.has(h))
                  .map((contentHash) => ({ contentHash }));
              }
              return [];
            },
          ),
          createMany: jest.fn(
            async ({ data }: { data: Array<{ contentHash: string }> }) => {
              for (const row of data) existingBlobHashes.add(row.contentHash);
              return { count: data.length };
            },
          ),
          deleteMany: jest.fn(async () => ({ count: 0 })),
        },
        pageTemplate: { upsert: jest.fn(async () => ({})) },
        pageTemplateFile: {
          deleteMany: jest.fn(async () => ({ count: 0 })),
          createMany: jest.fn(async () => ({ count: 2 })),
        },
        pageTemplateTag: {
          deleteMany: jest.fn(async () => ({ count: 0 })),
          createMany: jest.fn(async () => ({ count: 0 })),
        },
      };
      const repo = new TemplatesRepository({
        $transaction: async <T>(cb: (tx: typeof txMock) => Promise<T>) =>
          cb(txMock),
      } as never);

      const sharedFiles = [
        TemplateFileVo.fromText(
          'main.tex',
          '\\documentclass{article}\n\\begin{document}Hi\\end{document}',
        ),
        TemplateFileVo.fromAssetRef('logo.png', {
          blobId: BLOB_LOGO,
          storageKey: 'cas/logo.png',
          contentHash: 'e'.repeat(64),
          mimeType: 'image/png',
          sizeBytes: 512,
        }),
      ];

      const saved1 = await repo.saveWithLifecycle(
        TemplateManifest.create({
          name: 'T1',
          spaceId: USER_ALICE,
          spaceType: 'personal',
          createdById: USER_ALICE,
          files: sharedFiles,
        }),
      );
      const saved2 = await repo.saveWithLifecycle(
        TemplateManifest.create({
          name: 'T2',
          spaceId: USER_ALICE,
          spaceType: 'personal',
          createdById: USER_ALICE,
          files: sharedFiles,
        }),
      );

      expect(saved1.acquiredBlobIds).toEqual([BLOB_LOGO]);
      expect(saved2.acquiredBlobIds).toEqual([]);
    });

    it('instantiates a template atomically in one transaction and acquires referenced FileBlobs', async () => {
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
      const acquireBlob = jest.fn().mockResolvedValue({});
      const emit = jest.fn();

      const instantiator = new InstantiateService(
        {
          $transaction: jest.fn(
            async (cb: (tx: typeof txMock) => Promise<void>) => cb(txMock),
          ),
        } as never,
        { getAuthorizedManifest: jest.fn().mockResolvedValue(proto) } as never,
        { acquireBlob } as never,
        { emit } as never,
      );

      const res = await instantiator.instantiate(
        USER_ALICE,
        'xelatex-thesis',
        USER_ALICE,
        { title: 'My PhD Thesis' },
      );

      expect(res).toMatchObject({
        isPersonal: true,
        compiler: 'xelatex',
        texlive: '2025',
        createdDocs: 1,
        createdFiles: 1,
      });
      expect(res.rootDocId).toBe(res.pageId);
      expect(acquireBlob).toHaveBeenCalledWith(BLOB_LOGO);
      expect(emit).toHaveBeenCalledWith(
        'pages.file-tree.change',
        expect.objectContaining({ projectId: USER_ALICE }),
      );
    });
  });
});
