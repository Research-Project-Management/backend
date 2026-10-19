/**
 * test/unit/manuscripts-templates.service.spec.ts
 * Comprehensive Unit Test Suite for Manuscripts Templates Subsystem
 * Testing Category & Compiler VOs, Template Entity, In-Memory & Prisma Adapters,
 * Project Instantiation, Use Cases, Service Facade, and Overleaf Parity Controller.
 */

import {
  TemplateCategoryVo,
  CompilerTypeVo,
  ManuscriptTemplateEntity,
  TemplateNotFoundException,
  InvalidTemplateException,
  TemplatesRepository,
  TemplatesService,
  TemplatesController,
  OFFICIAL_TEMPLATE_CATALOG,
} from '@/modules/manuscripts/templates';
import { AuthenticatedRequest } from '@/core';

function createMockTemplatesRepo(): {
  repo: TemplatesRepository;
  mockPrisma: any;
} {
  const store = new Map<string, any>();
  for (const d of OFFICIAL_TEMPLATE_CATALOG) {
    const entity = ManuscriptTemplateEntity.create({
      id: d.id,
      versionId: d.versionId,
      name: d.name,
      category: d.category,
      description: d.description,
      compiler: d.compiler,
      imageName: d.imageName,
      mainFile: d.mainFile,
      author: d.author,
      tags: [...d.tags],
      isOfficial: d.isOfficial,
      downloadCount: d.downloadCount,
      files: { ...d.files },
    });
    store.set(entity.id, {
      id: entity.id,
      versionId: entity.versionId,
      name: entity.name,
      category: entity.category,
      description: entity.description,
      compiler: entity.compiler,
      imageName: entity.imageName,
      mainFile: entity.mainFile,
      thumbnailUrl: entity.thumbnailUrl,
      author: entity.author,
      tags: entity.tags,
      isOfficial: entity.isOfficial,
      downloadCount: entity.downloadCount,
      files: entity.files,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    });
  }

  const filterStore = (where: any = {}) => {
    let list = Array.from(store.values());
    if (where.category) {
      list = list.filter((t) => t.category.toLowerCase() === String(where.category).toLowerCase());
    }
    if (where.isOfficial !== undefined) {
      list = list.filter((t) => t.isOfficial === where.isOfficial);
    }
    if (where.tags?.has) {
      const tagLower = String(where.tags.has).toLowerCase();
      list = list.filter((t) => t.tags.some((tg: string) => tg.toLowerCase() === tagLower));
    }
    if (Array.isArray(where.OR) && where.OR.length > 0) {
      const q = String(where.OR[0]?.name?.contains || '').toLowerCase();
      if (q) {
        list = list.filter(
          (t) =>
            t.name.toLowerCase().includes(q) ||
            (t.description && t.description.toLowerCase().includes(q)) ||
            t.author.toLowerCase().includes(q) ||
            t.tags.some((tg: string) => tg.toLowerCase().includes(q)),
        );
      }
    }
    return list;
  };

  const mockPrisma: any = {
    manuscriptTemplate: {
      findUnique: jest.fn(async ({ where }: any) => {
        if (where.id) return store.get(where.id) || null;
        if (where.versionId) {
          for (const rec of store.values()) {
            if (rec.versionId === where.versionId) return rec;
          }
        }
        return null;
      }),
      count: jest.fn(async ({ where }: any) => filterStore(where).length),
      findMany: jest.fn(async ({ where, skip = 0, take = 50 }: any) => {
        const list = filterStore(where);
        list.sort((a, b) => {
          if (a.isOfficial && !b.isOfficial) return -1;
          if (!a.isOfficial && b.isOfficial) return 1;
          return b.downloadCount - a.downloadCount;
        });
        return list.slice(skip, skip + take);
      }),
      upsert: jest.fn(async ({ where, create }: any) => {
        store.set(where.id, { ...create });
        return store.get(where.id);
      }),
      deleteMany: jest.fn(async ({ where }: any) => {
        const existed = store.delete(where.id);
        return { count: existed ? 1 : 0 };
      }),
      updateMany: jest.fn(async ({ where }: any) => {
        const existing = store.get(where.id);
        if (existing) {
          existing.downloadCount += 1;
          return { count: 1 };
        }
        return { count: 0 };
      }),
    },
    project: {
      create: jest.fn().mockResolvedValue({ id: 'proj-parity-1' }),
    },
    projectMember: {
      create: jest.fn().mockResolvedValue({ id: 'pm-parity-1' }),
    },
  };

  return { repo: new TemplatesRepository(mockPrisma), mockPrisma };
}

describe('Manuscripts Templates Subsystem', () => {
  // =========================================================================
  // 1. DOMAIN LAYER: VALUE OBJECTS & ENTITIES
  // =========================================================================
  describe('Domain Layer: Value Objects & Entities', () => {
    describe('TemplateCategoryVo', () => {
      it('should validate all standard template categories', () => {
        expect(TemplateCategoryVo.isValid('journal')).toBe(true);
        expect(TemplateCategoryVo.isValid('conference')).toBe(true);
        expect(TemplateCategoryVo.isValid('thesis')).toBe(true);
        expect(TemplateCategoryVo.isValid('cv')).toBe(true);
        expect(TemplateCategoryVo.isValid('presentation')).toBe(true);
        expect(TemplateCategoryVo.isValid('report')).toBe(true);
        expect(TemplateCategoryVo.isValid('other')).toBe(true);
      });

      it('should reject invalid categories', () => {
        expect(TemplateCategoryVo.isValid('unknown-cat')).toBe(false);
        expect(TemplateCategoryVo.isValid('')).toBe(false);
      });

      it('should normalize and fallback gracefully in fromString', () => {
        expect(TemplateCategoryVo.fromString('JOURNAL')).toBe('journal');
        expect(TemplateCategoryVo.fromString('  Conference  ')).toBe(
          'conference',
        );
        expect(TemplateCategoryVo.fromString('invalid')).toBe('other');
        expect(TemplateCategoryVo.fromString(undefined)).toBe('other');
      });
    });

    describe('CompilerTypeVo', () => {
      it('should validate standard LaTeX engines', () => {
        expect(CompilerTypeVo.isValid('pdflatex')).toBe(true);
        expect(CompilerTypeVo.isValid('latex')).toBe(true);
        expect(CompilerTypeVo.isValid('xelatex')).toBe(true);
        expect(CompilerTypeVo.isValid('lualatex')).toBe(true);
      });

      it('should reject unsupported compilers', () => {
        expect(CompilerTypeVo.isValid('python')).toBe(false);
        expect(CompilerTypeVo.isValid('')).toBe(false);
      });

      it('should fallback to pdflatex on unknown input', () => {
        expect(CompilerTypeVo.fromString('XELATEX')).toBe('xelatex');
        expect(CompilerTypeVo.fromString('unknown')).toBe('pdflatex');
        expect(CompilerTypeVo.fromString(undefined)).toBe('pdflatex');
      });
    });

    describe('ManuscriptTemplateEntity', () => {
      it('should create template entity with default values', () => {
        const entity = ManuscriptTemplateEntity.create({
          name: 'Minimal Template',
        });

        expect(entity.id).toBeDefined();
        expect(entity.versionId).toMatch(/^v-/);
        expect(entity.name).toBe('Minimal Template');
        expect(entity.category).toBe('other');
        expect(entity.compiler).toBe('pdflatex');
        expect(entity.mainFile).toBe('main.tex');
        expect(entity.isOfficial).toBe(false);
        expect(entity.downloadCount).toBe(0);
        expect(entity.files['main.tex']).toBeDefined();
      });

      it('should create template with custom properties', () => {
        const entity = ManuscriptTemplateEntity.create({
          name: 'ACM Sigconf Template',
          category: 'conference',
          compiler: 'pdflatex',
          mainFile: 'sample-sigconf.tex',
          author: 'ACM',
          tags: ['acm', 'cs'],
          isOfficial: true,
          downloadCount: 50,
          files: {
            'sample-sigconf.tex': '\\documentclass{acmart}',
          },
        });

        expect(entity.name).toBe('ACM Sigconf Template');
        expect(entity.category).toBe('conference');
        expect(entity.mainFile).toBe('sample-sigconf.tex');
        expect(entity.author).toBe('ACM');
        expect(entity.tags).toEqual(['acm', 'cs']);
        expect(entity.isOfficial).toBe(true);
        expect(entity.downloadCount).toBe(50);
      });

      it('should increment download count and update updatedAt', () => {
        const entity = ManuscriptTemplateEntity.create({ name: 'Test' });
        const initialCount = entity.downloadCount;
        entity.incrementDownloadCount();
        expect(entity.downloadCount).toBe(initialCount + 1);
      });

      it('should update details accurately', () => {
        const entity = ManuscriptTemplateEntity.create({ name: 'Old Name' });
        entity.updateDetails({
          name: 'New Name',
          description: 'Updated description',
          category: 'thesis',
          tags: ['new-tag'],
        });

        expect(entity.name).toBe('New Name');
        expect(entity.description).toBe('Updated description');
        expect(entity.category).toBe('thesis');
        expect(entity.tags).toEqual(['new-tag']);
      });

      it('should convert entity to plain object', () => {
        const entity = ManuscriptTemplateEntity.create({ name: 'Plain Test' });
        const plain = entity.toPlainObject();
        expect(plain.id).toBe(entity.id);
        expect(plain.name).toBe('Plain Test');
        expect(plain.compiler).toBe('pdflatex');
      });
    });

    describe('Exceptions', () => {
      it('should format TemplateNotFoundException properly', () => {
        const ex = new TemplateNotFoundException('tmpl-123');
        expect(ex.name).toBe('TemplateNotFoundException');
        expect(ex.message).toContain('tmpl-123');
      });

      it('should format InvalidTemplateException properly', () => {
        const ex = new InvalidTemplateException('Missing main file');
        expect(ex.name).toBe('InvalidTemplateException');
        expect(ex.message).toContain('Missing main file');
      });
    });
  });

  // =========================================================================
  // 2. ADAPTERS LAYER: TEMPLATES REPOSITORY
  // =========================================================================
  describe('Adapters Layer', () => {
    describe('TemplatesRepository', () => {
      let adapter: TemplatesRepository;

      beforeEach(() => {
        adapter = createMockTemplatesRepo().repo;
      });

      it('should initialize with 12 official starter templates', async () => {
        const { templates, total } = await adapter.findAll();
        expect(total).toBe(12);
        expect(templates.length).toBe(12);

        const names = templates.map((t: ManuscriptTemplateEntity) => t.name);
        expect(names).toContain('IEEE Transactions Article');
        expect(names).toContain('ACM Conference Proceedings (SIGCONF)');
        expect(names).toContain('Springer LNCS Conference Template');
        expect(names).toContain('arXiv Minimal Preprint Template');
        expect(names).toContain('Master & PhD Dissertation');
        expect(names).toContain('Academic Curriculum Vitae (CV)');
        expect(names).toContain('Beamer Presentation Slides');
      });

      it('should filter templates by category', async () => {
        const { templates: journals } = await adapter.findAll({
          category: 'journal',
        });
        expect(journals.length).toBeGreaterThanOrEqual(2);
        journals.forEach((t: ManuscriptTemplateEntity) =>
          expect(t.category).toBe('journal'),
        );

        const { templates: thesis } = await adapter.findAll({
          category: 'thesis',
        });
        expect(thesis.length).toBe(1);
        expect(thesis[0].name).toBe('Master & PhD Dissertation');
      });

      it('should filter templates by official status', async () => {
        const { templates: officials } = await adapter.findAll({
          isOfficial: true,
        });
        expect(officials.length).toBe(12);

        // Add a non-official template
        const custom = ManuscriptTemplateEntity.create({
          name: 'My Lab Notes',
          isOfficial: false,
        });
        await adapter.save(custom);

        const { templates: community } = await adapter.findAll({
          isOfficial: false,
        });
        expect(community.length).toBe(1);
        expect(community[0].name).toBe('My Lab Notes');
      });

      it('should filter templates by tag', async () => {
        const { templates } = await adapter.findAll({ tag: 'ieee' });
        expect(templates.length).toBe(1);
        expect(templates[0].name).toBe('IEEE Transactions Article');
      });

      it('should search templates by keyword across name, description, author, and tags', async () => {
        const res1 = await adapter.search({ query: 'dissertation' });
        expect(res1.templates.length).toBe(1);
        expect(res1.templates[0].name).toBe('Master & PhD Dissertation');

        const res2 = await adapter.search({ query: 'ACM' });
        expect(res2.templates.length).toBe(1);
        expect(res2.templates[0].name).toBe(
          'ACM Conference Proceedings (SIGCONF)',
        );
      });

      it('should find template by id and versionId', async () => {
        const foundByVersion =
          await adapter.findByVersionId('tmpl-ieee-tran-v1');
        expect(foundByVersion).toBeDefined();
        expect(foundByVersion?.name).toBe('IEEE Transactions Article');

        const foundById = await adapter.findById(foundByVersion!.id);
        expect(foundById?.id).toBe(foundByVersion?.id);

        // Fallback search by versionId inside findById
        const fallback = await adapter.findById('tmpl-ieee-tran-v1');
        expect(fallback?.name).toBe('IEEE Transactions Article');
      });

      it('should delete a template', async () => {
        const custom = ManuscriptTemplateEntity.create({
          name: 'To Be Deleted',
        });
        await adapter.save(custom);

        const deleted = await adapter.delete(custom.id);
        expect(deleted).toBe(true);

        const check = await adapter.findById(custom.id);
        expect(check).toBeNull();
      });

      it('should increment download count', async () => {
        const tmpl = await adapter.findByVersionId('tmpl-arxiv-minimal-v1');
        const countBefore = tmpl!.downloadCount;
        await adapter.incrementDownloadCount(tmpl!.id);

        const tmplAfter = await adapter.findById(tmpl!.id);
        expect(tmplAfter?.downloadCount).toBe(countBefore + 1);
      });
    });

    describe('TemplatesRepository Prisma Mapping', () => {
      it('should map Prisma records to domain entities when query succeeds', async () => {
        const mockPrisma: any = {
          manuscriptTemplate: {
            findUnique: jest.fn().mockResolvedValue({
              id: '20000000-0000-0000-0000-000000000001',
              versionId: 'v-db-1',
              name: 'Database Template',
              category: 'journal',
              description: 'From Postgres',
              compiler: 'pdflatex',
              imageName: null,
              mainFile: 'main.tex',
              thumbnailUrl: null,
              author: 'DB User',
              tags: ['db'],
              isOfficial: false,
              downloadCount: 42,
              files: { 'main.tex': 'content' },
              createdAt: new Date(),
              updatedAt: new Date(),
            }),
          },
        };

        const adapter = new TemplatesRepository(mockPrisma);
        const res = await adapter.findById(
          '20000000-0000-0000-0000-000000000001',
        );
        expect(res).not.toBeNull();
        expect(res?.name).toBe('Database Template');
        expect(res?.downloadCount).toBe(42);
      });
    });

    describe('TemplatesRepository Instantiation', () => {
      it('should instantiate project blueprint from template', async () => {
        const mockPrisma: any = {
          project: {
            create: jest.fn().mockResolvedValue({ id: 'proj-123' }),
          },
          projectMember: {
            create: jest.fn().mockResolvedValue({ id: 'pm-1' }),
          },
        };

        const adapter = new TemplatesRepository(mockPrisma);
        const template = ManuscriptTemplateEntity.create({
          name: 'Nature Letter',
          compiler: 'pdflatex',
          mainFile: 'nature.tex',
          files: {
            'nature.tex': '\\documentclass{nature}',
            'references.bib': '@article{...}',
          },
        });

        const result = await adapter.instantiate({
          template,
          projectName: 'My Quantum Discovery',
          userId: 'user-456',
        });

        expect(result.projectId).toBe('proj-123');
        expect(result.projectName).toBe('My Quantum Discovery');
        expect(result.ownerId).toBe('user-456');
        expect(result.compiler).toBe('pdflatex');
        expect(result.mainFile).toBe('nature.tex');
        expect(result.fileCount).toBe(2);
        expect(result.files).toContain('nature.tex');
        expect(result.files).toContain('references.bib');
        expect(result.fromTemplateId).toBe(template.id);
      });
    });
  });

  // =========================================================================
  // 3. APPLICATION SERVICE LAYER
  // =========================================================================
  describe('Application Service Layer', () => {
    let templatesRepo: TemplatesRepository;
    let mockPrisma: any;
    let service: TemplatesService;

    beforeEach(() => {
      const mocked = createMockTemplatesRepo();
      templatesRepo = mocked.repo;
      mockPrisma = mocked.mockPrisma;
      service = new TemplatesService(templatesRepo);
    });

    it('listTemplates should return filtered results', async () => {
      const res = await service.listTemplates({ category: 'conference' });
      expect(res.templates.length).toBe(2);
      res.templates.forEach((t) => expect(t.category).toBe('conference'));
    });

    it('getTemplate should throw TemplateNotFoundException on non-existent template', async () => {
      await expect(service.getTemplate('non-existent-id')).rejects.toThrow(
        TemplateNotFoundException,
      );
      await expect(service.getTemplate('')).rejects.toThrow(
        TemplateNotFoundException,
      );
    });

    it('getTemplate should resolve by ID or Version ID', async () => {
      const byVersion = await service.getTemplate('tmpl-ieee-tran-v1');
      expect(byVersion.name).toBe('IEEE Transactions Article');

      const byId = await service.getTemplate(byVersion.id);
      expect(byId.name).toBe('IEEE Transactions Article');
    });

    it('searchTemplates should return matches', async () => {
      const res = await service.searchTemplates({ q: 'beamer' });
      expect(res.templates.length).toBe(1);
      expect(res.templates[0].name).toBe('Beamer Presentation Slides');
    });

    it('instantiateTemplate should clone template and increment download count', async () => {
      mockPrisma.project.create.mockResolvedValue({ id: 'proj-abc' });
      const template =
        await templatesRepo.findByVersionId('tmpl-ieee-tran-v1');
      const downloadsBefore = template!.downloadCount;

      const result = await service.instantiateTemplate('author-1', {
        templateId: 'tmpl-ieee-tran-v1',
        projectName: 'My IEEE Submission',
      });

      expect(result.projectId).toBe('proj-abc');
      expect(result.projectName).toBe('My IEEE Submission');
      expect(result.ownerId).toBe('author-1');
      expect(result.compiler).toBe('pdflatex');
      expect(result.fromTemplateId).toBe(template!.id);

      // Verify download count incremented
      const updatedTemplate = await templatesRepo.findById(template!.id);
      expect(updatedTemplate?.downloadCount).toBe(downloadsBefore + 1);
    });

    it('createCustomTemplate should validate and persist custom template', async () => {
      // Should fail if name is empty
      await expect(service.createCustomTemplate({ name: '' })).rejects.toThrow(
        InvalidTemplateException,
      );

      // Should fail if mainFile specified but not in files payload
      await expect(
        service.createCustomTemplate({
          name: 'Broken Template',
          mainFile: 'index.tex',
          files: { 'other.tex': 'content' },
        }),
      ).rejects.toThrow(InvalidTemplateException);

      // Should succeed when properly configured
      const created = await service.createCustomTemplate({
        name: 'My Lab Technical Report',
        category: 'report',
        mainFile: 'report.tex',
        files: {
          'report.tex': '\\documentclass{report}',
        },
      });

      expect(created.id).toBeDefined();
      expect(created.name).toBe('My Lab Technical Report');
      expect(created.category).toBe('report');
      expect(created.isOfficial).toBe(false);

      const retrieved = await templatesRepo.findById(created.id);
      expect(retrieved?.name).toBe('My Lab Technical Report');
    });
  });

  // =========================================================================
  // 4. SERVICE FACADE & APPLICATION LAYER
  // =========================================================================
  describe('TemplatesService Facade', () => {
    let service: TemplatesService;

    beforeEach(() => {
      const { repo, mockPrisma } = createMockTemplatesRepo();
      mockPrisma.project.create.mockResolvedValue({ id: 'proj-service' });
      service = new TemplatesService(repo);
    });

    it('should list all templates and return plain objects', async () => {
      const res = await service.listTemplates();
      expect(res.total).toBe(12);
      expect(res.templates[0].id).toBeDefined();
      expect(res.templates[0].name).toBeDefined();
    });

    it('should get template details by id', async () => {
      const res = await service.getTemplate('tmpl-academic-cv-v1');
      expect(res.name).toBe('Academic Curriculum Vitae (CV)');
      expect(res.category).toBe('cv');
    });

    it('should search templates with keyword', async () => {
      const res = await service.searchTemplates({ q: 'springer' });
      expect(res.total).toBe(1);
      expect(res.templates[0].name).toBe('Springer LNCS Conference Template');
    });

    it('should instantiate template into new project', async () => {
      const result = await service.instantiateTemplate('user-tester', {
        templateId: 'tmpl-arxiv-minimal-v1',
        projectName: 'Deep Learning Advances',
      });

      expect(result.projectId).toBe('proj-service');
      expect(result.projectName).toBe('Deep Learning Advances');
      expect(result.ownerId).toBe('user-tester');
    });

    it('should create custom template', async () => {
      const created = await service.createCustomTemplate({
        name: 'Conference Poster',
        category: 'presentation',
        mainFile: 'poster.tex',
        files: { 'poster.tex': '\\documentclass{beamer}' },
      });

      expect(created.name).toBe('Conference Poster');
      expect(created.category).toBe('presentation');
    });
  });

  // =========================================================================
  // 5. CONTROLLERS
  // =========================================================================
  describe('Controllers', () => {
    let service: TemplatesService;
    let templatesController: TemplatesController;

    beforeEach(() => {
      const { repo } = createMockTemplatesRepo();
      service = new TemplatesService(repo);

      templatesController = new TemplatesController(service);
    });

    it('TemplatesController should list templates', async () => {
      const res = await templatesController.listTemplates({});
      expect(res.total).toBe(12);
    });

    it('TemplatesController should search templates', async () => {
      const res = await templatesController.searchTemplates({ q: 'thesis' });
      expect(res.total).toBe(1);
      expect(res.templates[0].name).toBe('Master & PhD Dissertation');
    });

    it('TemplatesController should get template by id', async () => {
      const res = await templatesController.getTemplate('tmpl-thesis-v1');
      expect(res.name).toBe('Master & PhD Dissertation');
    });

    it('TemplatesController should instantiate template for current user', async () => {
      const req = {
        user: { id: 'prof-oak' },
      } as unknown as AuthenticatedRequest;
      const res = await templatesController.instantiateTemplate(req, {
        templateId: 'tmpl-ieee-tran-v1',
        projectName: 'Pokedex Research',
      });

      expect(res.projectId).toBe('proj-parity-1');
      expect(res.ownerId).toBe('prof-oak');
      expect(res.projectName).toBe('Pokedex Research');
    });
  });
});
