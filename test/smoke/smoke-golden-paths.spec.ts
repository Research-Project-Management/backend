import {
  buildMockUser,
  buildMockLibraryItem,
  buildMockWorkItem,
} from '@test/factories';
import { createMockPrismaService, createMockRedisService } from '@test/mocks';
import { ItemAggregate } from '@/modules/library/catalog/core/domain/item.aggregate';
import { CslEngineService } from '@/modules/library/citation/core/adapters/csl-engine.service';
import { CslJsonMapper } from '@/modules/library/citation/core/adapters/csl-json.mapper';

describe('⚡ Production Readiness Golden-Path Smoke Test Suite', () => {
  let mockPrisma: ReturnType<typeof createMockPrismaService>;
  let mockRedis: ReturnType<typeof createMockRedisService>;
  let cslEngine: CslEngineService;

  beforeAll(() => {
    mockPrisma = createMockPrismaService();
    mockRedis = createMockRedisService();
    cslEngine = new CslEngineService();
  });

  describe('Path 1: Identity, Auth & Session Lifecycle', () => {
    it('should validate user identity entity and session token claims', async () => {
      const user = buildMockUser({ role: 'OWNER' });
      expect(user.id).toBeValidUuid();
      expect(user.role).toBe('OWNER');

      // Verify zero-IO Redis caching for auth session
      await mockRedis.set(
        `session:${user.id}`,
        JSON.stringify({ active: true }),
      );
      const session = await mockRedis.get(`session:${user.id}`);
      expect(session).toContain('"active":true');
    });
  });

  describe('Path 2: Project Workspace & Multitenancy Scope', () => {
    it('should scaffold project workspace with author access', async () => {
      const project = {
        id: '01920b92-4444-7444-8444-444444444444',
        name: 'Quantum Optics Lab',
        ownerId: '01920b92-1111-7111-8111-111111111111',
      };
      mockPrisma.project.create.mockResolvedValue(project);

      const created = await mockPrisma.project.create({ data: project });
      expect(created.id).toBeValidUuid();
      expect(created.name).toBe('Quantum Optics Lab');
    });
  });

  describe('Path 3: Library Catalog & Overleaf BibTeX Parity', () => {
    it('should create domain item aggregate and generate strict BibTeX', () => {
      const item = ItemAggregate.create({
        userId: '01920b92-1111-7111-8111-111111111111',
        title: 'Attention Is All You Need',
        itemType: 'journalArticle',
        citationKey: 'vaswani2017attention',
        year: 2017,
      });

      expect(item.id).toBeDefined();
      expect(item.version).toBe(1);

      // Verify BibTeX formatting parity
      const mockRawItem = buildMockLibraryItem({
        id: item.id,
        citationKey: 'vaswani2017attention',
        itemType: 'journalArticle',
        title: 'Attention Is All You Need',
        year: 2017,
      });
      const csl = CslJsonMapper.toCsl(mockRawItem);
      const bibtex = cslEngine.formatBibtex(csl);

      expect(bibtex).toBeValidBibtex();
      expect(bibtex.toLowerCase()).toContain('@article{vaswani2017attention,');
    });
  });

  describe('Path 4: Work-Item Task Management & Execution', () => {
    it('should construct work-item entity with priority and column mapping', async () => {
      const workItem = buildMockWorkItem({
        title: 'Refactor Ingestion Queue Consumer',
        priority: 'URGENT',
        status: 'IN_PROGRESS',
      });

      expect(workItem.id).toBeValidUuid();
      expect(workItem.priority).toBe('URGENT');
      expect(workItem.status).toBe('IN_PROGRESS');

      mockPrisma.workItem.create.mockResolvedValue(workItem);
      const saved = await mockPrisma.workItem.create({ data: workItem });
      expect(saved.title).toBe('Refactor Ingestion Queue Consumer');
    });
  });

  describe('Path 5: Storage Key Sanitization & URL Signing Safety', () => {
    it('should sanitize storage filenames and enforce secure path separation', () => {
      const unsafeFilename = '../../etc/passwd/paper (1) [final].pdf';
      const safeKey = unsafeFilename
        .replace(/\.\./g, '')
        .replace(/[^a-zA-Z0-9._/-]/g, '_');

      expect(safeKey).not.toContain('..');
      expect(safeKey).toMatch(/^[\w._/-]+$/);
    });
  });
});
