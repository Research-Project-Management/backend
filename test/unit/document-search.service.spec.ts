import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { SearchService } from '@/modules/document/search/search.service';
import { PrismaService } from '@/core/database/prisma.service';
import { PageRepository } from '@/modules/document/page/page.repository';
import { YjsDocumentManager } from '@/modules/document/collaboration/yjs-document.manager';
import { CollaborationGateway } from '@/modules/document/collaboration/collaboration.gateway';
import { HistoryService } from '@/modules/document/history/history.service';

describe('SearchService', () => {
  let service: SearchService;
  let prisma: jest.Mocked<any>;
  let pageRepo: jest.Mocked<any>;
  let yjsManager: jest.Mocked<any>;
  let collaborationGateway: jest.Mocked<any>;
  let historyService: jest.Mocked<any>;

  const mockProjectId = '11111111-1111-1111-1111-111111111111';

  beforeEach(async () => {
    prisma = {
      project: {
        findFirst: jest.fn().mockResolvedValue({ id: mockProjectId }),
      },
      page: {
        findMany: jest.fn(),
        update: jest.fn(),
      },
    };

    pageRepo = {
      findProjectPages: jest.fn(),
    };

    yjsManager = {
      hasActiveSession: jest.fn().mockReturnValue(false),
      getText: jest.fn().mockReturnValue(''),
      replaceText: jest.fn(),
    };

    collaborationGateway = {
      server: {
        to: jest.fn().mockReturnValue({
          emit: jest.fn(),
        }),
      },
    };

    historyService = {
      createVersion: jest.fn().mockResolvedValue({ id: 'ver-1' }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SearchService,
        { provide: PrismaService, useValue: prisma },
        { provide: PageRepository, useValue: pageRepo },
        { provide: YjsDocumentManager, useValue: yjsManager },
        { provide: CollaborationGateway, useValue: collaborationGateway },
        { provide: HistoryService, useValue: historyService },
      ],
    }).compile();

    service = module.get<SearchService>(SearchService);
  });

  describe('buildRegex', () => {
    it('should build case-insensitive regex by default', () => {
      const re = service.buildRegex('latex');
      expect(re.test('LaTeX')).toBe(true);
      re.lastIndex = 0;
      expect(re.test('latex')).toBe(true);
    });

    it('should escape special regex characters when useRegex is false', () => {
      const re = service.buildRegex('item[0]');
      expect(re.test('item[0]')).toBe(true);
      re.lastIndex = 0;
      expect(re.test('item0')).toBe(false);
    });

    it('should respect wholeWord option', () => {
      const re = service.buildRegex('doc', false, true, false);
      expect(re.test('doc')).toBe(true);
      re.lastIndex = 0;
      expect(re.test('document')).toBe(false);
    });

    it('should respect useRegex option and allow custom patterns', () => {
      const re = service.buildRegex('\\\\section\\{.*\\}', true, false, true);
      expect(re.test('\\section{Introduction}')).toBe(true);
      re.lastIndex = 0;
      expect(re.test('section{Introduction}')).toBe(false);
    });

    it('should throw BadRequestException on invalid regex syntax', () => {
      expect(() => {
        service.buildRegex('[unclosed-bracket', false, false, true);
      }).toThrow(BadRequestException);
    });
  });

  describe('searchProjectDocuments', () => {
    it('should return empty result for blank query', async () => {
      const res = await service.searchProjectDocuments(mockProjectId, { query: '   ' });
      expect(res.totalFiles).toBe(0);
      expect(res.totalMatches).toBe(0);
      expect(res.results).toEqual([]);
    });

    it('should search pages from database when no active Yjs session', async () => {
      prisma.page.findMany.mockResolvedValue([
        {
          id: 'page-1',
          title: 'main.tex',
          content: 'Hello World\nThis is a LaTeX document.\nHello again!',
          mainFileId: 'page-1',
        },
        {
          id: 'page-2',
          title: 'intro.tex',
          content: 'No matches here.',
          mainFileId: null,
        },
      ]);

      const res = await service.searchProjectDocuments(mockProjectId, {
        query: 'hello',
        caseSensitive: false,
      });

      expect(res.totalFiles).toBe(1);
      expect(res.totalMatches).toBe(2);
      expect(res.results[0].fileId).toBe('page-1');
      expect(res.results[0].matches.length).toBe(2);
      expect(res.results[0].matches[0].line).toBe(1);
      expect(res.results[0].matches[1].line).toBe(3);
    });

    it('should prioritize live in-memory Yjs buffer over stale database content', async () => {
      prisma.page.findMany.mockResolvedValue([
        {
          id: 'page-1',
          title: 'main.tex',
          content: 'stale database content',
          mainFileId: 'page-1',
        },
      ]);

      yjsManager.hasActiveSession.mockImplementation((id: string) => id === 'page-1');
      yjsManager.getText.mockReturnValue('fresh live collaborative content with keyword');

      const res = await service.searchProjectDocuments(mockProjectId, {
        query: 'keyword',
      });

      expect(res.totalFiles).toBe(1);
      expect(res.totalMatches).toBe(1);
      expect(res.results[0].matches[0].snippet).toContain('keyword');
    });

    it('should respect maxResults limit and set truncated to true', async () => {
      prisma.page.findMany.mockResolvedValue([
        {
          id: 'page-1',
          title: 'main.tex',
          content: 'match match match match match',
          mainFileId: 'page-1',
        },
      ]);

      const res = await service.searchProjectDocuments(mockProjectId, {
        query: 'match',
        maxResults: 3,
      });

      expect(res.totalMatches).toBe(3);
      expect(res.truncated).toBe(true);
    });
  });

  describe('batchReplaceProjectDocuments', () => {
    it('should replace text across database pages when not in active session', async () => {
      prisma.page.findMany.mockResolvedValue([
        {
          id: 'page-1',
          title: 'main.tex',
          content: 'oldTerm in line 1\noldTerm in line 2',
          projectId: mockProjectId,
        },
        {
          id: 'page-2',
          title: 'other.tex',
          content: 'unrelated text',
          projectId: mockProjectId,
        },
      ]);

      const res = await service.batchReplaceProjectDocuments(
        mockProjectId,
        'user-1',
        {
          query: 'oldTerm',
          replaceWith: 'newTerm',
        },
      );

      expect(res.totalFilesAffected).toBe(1);
      expect(res.totalOccurrencesReplaced).toBe(2);
      expect(res.affectedFileIds).toEqual(['page-1']);
      expect(prisma.page.update).toHaveBeenCalledWith({
        where: { id: 'page-1' },
        data: { content: 'newTerm in line 1\nnewTerm in line 2' },
      });
      expect(historyService.createVersion).toHaveBeenCalled();
    });

    it('should apply replace to active Yjs session and broadcast update via gateway', async () => {
      prisma.page.findMany.mockResolvedValue([
        {
          id: 'page-active',
          title: 'active.tex',
          content: 'old term in db',
          projectId: mockProjectId,
        },
      ]);

      yjsManager.hasActiveSession.mockReturnValue(true);
      yjsManager.getText.mockReturnValue('live old term text');
      const fakeBinaryUpdate = new Uint8Array([1, 2, 3]);
      yjsManager.replaceText.mockResolvedValue(fakeBinaryUpdate);

      const res = await service.batchReplaceProjectDocuments(
        mockProjectId,
        'user-1',
        {
          query: 'old term',
          replaceWith: 'replaced term',
        },
      );

      expect(res.totalFilesAffected).toBe(1);
      expect(yjsManager.replaceText).toHaveBeenCalledWith(
        'page-active',
        'live replaced term text',
        'user-1',
      );
      expect(collaborationGateway.server.to).toHaveBeenCalledWith('doc:page-active');
    });
  });
});
