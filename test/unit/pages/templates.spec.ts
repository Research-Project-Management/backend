import { Readable } from 'node:stream';
import {
  InvalidTemplateError,
  TemplateForbiddenError,
  TemplateNotFoundError,
} from '@/modules/pages/templates/domain/errors';
import { OFFICIAL_TEMPLATES } from '@/modules/pages/templates/domain/catalog.domain';
import { TemplateFileVo } from '@/modules/pages/templates/domain/file.domain';
import { TemplateManifest } from '@/modules/pages/templates/domain/manifest.domain';
import {
  TEMPLATE_CATEGORIES,
  assertCategory,
  canManageTemplate,
  canReadTemplate,
} from '@/modules/pages/templates/domain/policy';
import { GalleryService } from '@/modules/pages/templates/services/gallery.service';
import { PublishService } from '@/modules/pages/templates/services/publish.service';
import { ScaffoldService } from '@/modules/pages/templates/services/scaffold.service';

const USER_ALICE = '11111111-1111-4111-8111-111111111111';
const USER_BOB = '22222222-2222-4222-8222-222222222222';
const SPACE_TEAM = '33333333-3333-4333-8333-333333333333';
const PAGE_SOURCE = '44444444-4444-4444-8444-444444444444';

describe('Templates Module (1 File = 1 Business, BCNF + GoF Deep Modules)', () => {
  describe('1. File Value Object (`file.domain.ts`) & Manifest Prototype (`manifest.domain.ts`)', () => {
    it('computes deterministic SHA-256 CAS hashes for text & binary assets and rejects path traversal or invalid categories', () => {
      const texA = TemplateFileVo.fromText(
        'main.tex',
        '\\documentclass{article}\r\n\\begin{document}Hi\\end{document}',
      );
      const texB = TemplateFileVo.fromText(
        '/main.tex',
        '\\documentclass{article}\n\\begin{document}Hi\\end{document}',
      );

      expect(texA.path).toBe('main.tex');
      expect(texA.kind).toBe('doc');
      expect(texA.contentHash).toHaveLength(64);
      expect(texA.contentHash).toBe(texB.contentHash);

      const pngBytes = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01,
      ]);
      const logo = TemplateFileVo.fromBuffer('figures/logo.png', pngBytes);
      expect(logo.kind).toBe('file');
      expect(logo.mimeType).toBe('image/png');
      expect(logo.textContent).toBeNull();
      expect(logo.toView().base64).toBe(pngBytes.toString('base64'));

      expect(() => TemplateFileVo.fromText('../etc/passwd', 'bad')).toThrow(
        InvalidTemplateError,
      );
      expect(() => assertCategory('resume')).toThrow(InvalidTemplateError);
    });

    it('separates Virtual Proxy summary (0 file bytes) from full detail & Prototype clonePlan()', () => {
      const tex = TemplateFileVo.fromText(
        'paper.tex',
        '\\documentclass[conference]{IEEEtran}\n\\begin{document}Hello\\end{document}',
      );
      const png = TemplateFileVo.fromBuffer(
        'assets/diagram.png',
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]),
      );

      const manifest = TemplateManifest.create({
        name: 'IEEE Conference Paper',
        category: 'conference',
        compiler: 'xelatex',
        texLiveVersion: '2025',
        mainFile: 'paper.tex',
        tags: ['IEEE', 'Conference', 'ieee'],
        files: [tex, png],
      });

      expect(manifest.badge).toBe('IEEEtran');
      expect(manifest.tags).toEqual(['ieee', 'conference']);

      const summary = manifest.toSummary();
      expect(summary.fileCount).toBe(2);
      expect('files' in summary).toBe(false);

      const detail = manifest.toDetail();
      expect(detail.files).toHaveLength(2);

      const plan = manifest.clonePlan('My Custom Clone');
      expect(plan.title).toBe('My Custom Clone');
      expect(plan.compiler).toBe('xelatex');
      expect(plan.texLiveVersion).toBe('2025');
      expect(plan.files.find((f) => f.path === 'assets/diagram.png')?.dir).toBe(
        '/assets',
      );
    });
  });

  describe('2. Flyweight Official Catalog (`catalog.domain.ts`)', () => {
    it('defines 13 curated official templates with unique canonical UUIDs and slugs across all 10 academic categories', () => {
      expect(TEMPLATE_CATEGORIES).toHaveLength(11);
      expect(OFFICIAL_TEMPLATES).toHaveLength(13);

      const ids = new Set(OFFICIAL_TEMPLATES.map((t) => t.id));
      const slugs = new Set(OFFICIAL_TEMPLATES.map((t) => t.slug));
      expect(ids.size).toBe(13);
      expect(slugs.size).toBe(13);
      expect(slugs.has('ieee-transactions')).toBe(true);
      expect(slugs.has('acm-sigconf')).toBe(true);
      expect(slugs.has('beamer-presentation')).toBe(true);
    });
  });

  describe('3. Gallery RBAC & Metadata CRUD (`GalleryService`)', () => {
    it('enforces read/manage rules across official, private, and workspace templates', async () => {
      expect(
        canReadTemplate({
          visibility: 'private',
          createdById: USER_ALICE,
          userId: USER_BOB,
          isOperator: false,
          canReadSpace: false,
        }),
      ).toBe(false);

      expect(
        canManageTemplate({
          visibility: 'official',
          createdById: null,
          userId: USER_ALICE,
          isOperator: false,
          canWriteSpace: false,
        }),
      ).toBe(false);

      const privateByAlice = TemplateManifest.create({
        id: '55555555-5555-4555-8555-555555555555',
        name: 'Alice Secret Template',
        visibility: 'private',
        createdById: USER_ALICE,
        files: [
          TemplateFileVo.fromText('main.tex', '\\documentclass{article}'),
        ],
      });

      const mockRepo = {
        findSummaries: jest
          .fn()
          .mockResolvedValue({ items: [privateByAlice], total: 1 }),
        findDetail: jest.fn().mockResolvedValue(privateByAlice),
        save: jest.fn(),
        deleteById: jest.fn().mockResolvedValue(true),
      };

      const gallery = new GalleryService(mockRepo as never);

      await expect(
        gallery.getDetail(privateByAlice.id, USER_BOB),
      ).rejects.toThrow(TemplateNotFoundError);

      const detail = await gallery.getDetail(privateByAlice.id, USER_ALICE);
      expect(detail.id).toBe(privateByAlice.id);

      await expect(gallery.remove(privateByAlice.id, USER_BOB)).rejects.toThrow(
        TemplateForbiddenError,
      );
      await gallery.remove(privateByAlice.id, USER_ALICE);
      expect(mockRepo.deleteById).toHaveBeenCalledWith(privateByAlice.id);
    });
  });

  describe('4. Workspace Snapshot Publisher (`PublishService`)', () => {
    it('snapshots both Docstore text docs AND Filestore binary streams when publishing a workspace', async () => {
      const savedManifests: TemplateManifest[] = [];
      const pngBuf = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]);

      const prisma = {
        page: {
          findFirst: jest.fn().mockResolvedValue({
            id: PAGE_SOURCE,
            spaceId: SPACE_TEAM,
            compiler: 'lualatex',
            texlive: '2025',
            rootDoc: { lastKnownPath: '/paper.tex' },
          }),
        },
      };
      const repo = {
        save: jest.fn(async (m: TemplateManifest) => {
          savedManifests.push(m);
          return m;
        }),
      };
      const gallery = {
        hasSpaceAccess: jest.fn().mockResolvedValue(true),
      };
      const structure = {
        getAllNodes: jest.fn().mockResolvedValue([
          {
            id: 'n1',
            path: '/paper.tex',
            name: 'paper.tex',
            type: 'DOC',
            docId: 'd1',
          },
          { id: 'n2', path: '/figs', name: 'figs', type: 'FOLDER' },
          {
            id: 'n3',
            path: '/figs/plot.png',
            name: 'plot.png',
            type: 'FILE',
            fileId: 'f1',
          },
        ]),
      };
      const docstore = {
        getAllDocs: jest.fn().mockResolvedValue([
          {
            _id: 'd1',
            lines: [
              '\\documentclass{article}',
              '\\begin{document}Hi\\end{document}',
            ],
          },
        ]),
      };
      const filestore = {
        openReadStream: jest.fn().mockResolvedValue({
          file: { mimeType: 'image/png' },
          stream: Readable.from([pngBuf]),
        }),
      };

      const publisher = new PublishService(
        prisma as never,
        repo as never,
        gallery as never,
        structure as never,
        docstore as never,
        filestore as never,
      );

      await expect(
        publisher.publish(USER_ALICE, {
          name: 'Illegal Official',
          visibility: 'official',
          pageId: PAGE_SOURCE,
        }),
      ).rejects.toThrow(TemplateForbiddenError);

      const published = await publisher.publish(USER_ALICE, {
        name: 'Lab Paper Template',
        category: 'journal',
        visibility: 'workspace',
        pageId: PAGE_SOURCE,
        tags: ['lab', 'lualatex'],
      });

      expect(published.compiler).toBe('lualatex');
      expect(published.texLiveVersion).toBe('2025');
      expect(published.mainFile).toBe('paper.tex');
      expect(published.fileCount).toBe(2);
      expect(
        published.files.find((f) => f.path === 'figs/plot.png')?.kind,
      ).toBe('file');
      expect(savedManifests).toHaveLength(1);
    });
  });

  describe('5. Prototype Workspace Scaffolder (`ScaffoldService`)', () => {
    it('scaffolds a new Page with aligned rootDocId===pageId & compiler, and compensates via SagaRunner on failure', async () => {
      const pngBuf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02]);
      const proto = TemplateManifest.create({
        id: '66666666-6666-4666-8666-666666666666',
        slug: 'xelatex-thesis',
        name: 'XeLaTeX Thesis',
        category: 'thesis',
        compiler: 'xelatex',
        texLiveVersion: '2025',
        mainFile: 'thesis.tex',
        files: [
          TemplateFileVo.fromText(
            'thesis.tex',
            '\\documentclass{report}\n\\begin{document}Thesis\\end{document}',
          ),
          TemplateFileVo.fromBuffer('images/seal.png', pngBuf, 'image/png'),
        ],
      });

      const deletedPageIds: string[] = [];

      const prisma = {
        space: { upsert: jest.fn().mockResolvedValue({}) },
        page: {
          create: jest.fn(async ({ data }: { data: unknown }) => data),
          update: jest.fn().mockResolvedValue({}),
          delete: jest.fn(async ({ where }: { where: { id: string } }) => {
            deletedPageIds.push(where.id);
          }),
        },
      };
      const repo = {
        incrementDownloads: jest.fn().mockResolvedValue(undefined),
      };
      const gallery = {
        getAuthorizedManifest: jest.fn().mockResolvedValue(proto),
      };
      const structure = {
        mkdirp: jest.fn().mockResolvedValue({ id: 'folder-images' }),
        createNode: jest.fn(async (_s: string, input: { name: string }) => ({
          id: `node-${input.name}`,
        })),
        setRootDoc: jest.fn().mockResolvedValue(undefined),
      };
      const docstore = {
        createDoc: jest.fn(async (_s: string, input: { id?: string }) => ({
          _id: input.id ?? 'doc-random',
        })),
      };
      const filestore = {
        uploadFileFromBuffer: jest.fn().mockResolvedValue({ id: 'file-seal' }),
      };

      const scaffolder = new ScaffoldService(
        prisma as never,
        repo as never,
        gallery as never,
        structure as never,
        docstore as never,
        filestore as never,
      );

      const res = await scaffolder.scaffold(
        USER_ALICE,
        'xelatex-thesis',
        USER_ALICE,
        { title: 'My PhD Thesis' },
      );

      expect(res.compiler).toBe('xelatex');
      expect(res.mainFile).toBe('thesis.tex');
      expect(res.importedDocs).toBe(1);
      expect(res.importedFiles).toBe(1);
      expect(res.rootDocId).toBe(res.pageId);
      expect(prisma.page.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            id: res.pageId,
            title: 'My PhD Thesis',
            compiler: 'xelatex',
            texlive: '2025',
          }),
        }),
      );

      docstore.createDoc.mockRejectedValueOnce(
        new Error('Simulated DB outage'),
      );
      await expect(
        scaffolder.scaffold(USER_ALICE, 'xelatex-thesis', USER_ALICE, {
          title: 'Broken Clone',
        }),
      ).rejects.toThrow('Simulated DB outage');
      expect(deletedPageIds).toHaveLength(1);
    });
  });
});
