import { Test, TestingModule } from '@nestjs/testing';
import { OutlineService } from '@/modules/document/outline/outline.service';
import { PrismaService } from '@/core/database/prisma.service';
import { NotFoundException } from '@nestjs/common';

describe('Document OutlineService', () => {
  let service: OutlineService;
  let prisma: any;

  const mockPageId = '11111111-1111-1111-1111-111111111111';

  beforeEach(async () => {
    prisma = {
      page: {
        findFirst: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [OutlineService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = module.get<OutlineService>(OutlineService);
  });

  describe('parseOutlineFromSource', () => {
    it('should parse LaTeX sectioning commands correctly', () => {
      const latex = `
\\section{Introduction}
Some text here.
% \\section{Ignored Comment}
\\subsection{Background}
Details...
\\subsubsection{Prior Works}
\\paragraph{Note}
      `;

      const entries = service.parseOutlineFromSource(latex, 'main.tex');

      expect(entries).toHaveLength(4);
      expect(entries[0].title).toBe('Introduction');
      expect(entries[0].levelName).toBe('Section');
      expect(entries[0].level).toBe(1);

      expect(entries[1].title).toBe('Background');
      expect(entries[1].levelName).toBe('Subsection');
      expect(entries[1].level).toBe(2);

      expect(entries[2].title).toBe('Prior Works');
      expect(entries[2].levelName).toBe('Subsubsection');

      expect(entries[3].title).toBe('Note');
      expect(entries[3].levelName).toBe('Paragraph');
    });

    it('should parse Markdown headings as fallback', () => {
      const md = `
# Project Overview
## System Architecture
### Database Schema
      `;

      const entries = service.parseOutlineFromSource(md, 'notes.md');

      expect(entries).toHaveLength(3);
      expect(entries[0].title).toBe('Project Overview');
      expect(entries[0].level).toBe(0);
      expect(entries[1].title).toBe('System Architecture');
      expect(entries[1].level).toBe(1);
      expect(entries[2].title).toBe('Database Schema');
      expect(entries[2].level).toBe(2);
    });
  });

  describe('buildNestedOutlineTree', () => {
    it('should assemble nested hierarchical tree', () => {
      const entries = [
        { id: '1', level: 1, levelName: 'Section', title: 'Intro', line: 1 },
        {
          id: '2',
          level: 2,
          levelName: 'Subsection',
          title: 'Context',
          line: 5,
        },
        { id: '3', level: 1, levelName: 'Section', title: 'Methods', line: 10 },
      ];

      const tree = service.buildNestedOutlineTree(entries);

      expect(tree).toHaveLength(2); // Intro & Methods
      expect(tree[0].title).toBe('Intro');
      expect(tree[0].children).toHaveLength(1);
      expect(tree[0].children![0].title).toBe('Context');
      expect(tree[1].title).toBe('Methods');
      expect(tree[1].children).toHaveLength(0);
    });
  });

  describe('getDocumentOutline', () => {
    it('should throw NotFoundException if document not found', async () => {
      prisma.page.findFirst.mockResolvedValueOnce(null);

      await expect(service.getDocumentOutline(mockPageId)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should extract outline across root and child pages', async () => {
      prisma.page.findFirst.mockResolvedValueOnce({
        id: mockPageId,
        title: 'Survey Paper',
        content: '\\section{Overview}\nOverview content.',
        childPages: [
          {
            id: 'child-1',
            title: 'method.tex',
            content: '\\section{Methodology}\n\\subsection{Algorithm}',
          },
        ],
      });

      const res = await service.getDocumentOutline(mockPageId);

      expect(res.entries).toHaveLength(3);
      expect(res.totalHeadings).toBe(3);
      expect(res.entries[0].title).toBe('Overview');
      expect(res.entries[1].title).toBe('Methodology');
      expect(res.entries[2].title).toBe('Algorithm');
      expect(res.tree).toHaveLength(2); // 2 top sections
    });
  });
});
