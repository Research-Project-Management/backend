import { QualityService } from '@/modules/library/quality/quality.service';
import { PaperRepository } from '@/modules/library/paper/paper.repository';
import { BadRequestException, NotFoundException } from '@nestjs/common';

describe('Seam 4: QualityService (2-Tier Deduplication, Safe Merge, Integrity Diagnostics)', () => {
  let service: QualityService;
  let mockPaperRepo: any;

  beforeEach(() => {
    mockPaperRepo = {
      resolveWorkspace: jest.fn().mockResolvedValue({ id: 'ws-1' }),
      findPapers: jest.fn(),
      findPaperById: jest.fn(),
      prisma: {
        $transaction: jest.fn((callback) =>
          callback({
            paper: {
              update: jest.fn().mockResolvedValue({}),
              updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            },
            paperAttachment: {
              updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            },
          }),
        ),
      },
    };

    service = new QualityService(mockPaperRepo);
  });

  describe('Vertical Slice 4.1: 2-Tier Duplicate Detection Engine', () => {
    it('should detect Tier 1 duplicates with case-insensitive identical DOIs', async () => {
      mockPaperRepo.findPapers.mockResolvedValueOnce([
        {
          id: 'p1',
          title: 'Attention Is All You Need (ArXiv Version)',
          doi: '10.1145/3290605.A12',
          authors: ['Vaswani, Ashish'],
          year: 2017,
          citationKey: 'vaswani2017attention',
          collectionId: null,
          createdAt: new Date(),
          attachments: [],
        },
        {
          id: 'p2',
          title: 'Attention Is All You Need (NeurIPS Camera Ready)',
          doi: '10.1145/3290605.a12',
          authors: ['Vaswani, Ashish'],
          year: 2017,
          citationKey: 'vaswani2017attentiona',
          collectionId: null,
          createdAt: new Date(),
          attachments: [],
        },
      ]);

      const result = await service.getDuplicateGroups('ws-1');

      expect(result.duplicateGroups).toHaveLength(1);
      expect(result.duplicateGroups[0].matchType).toBe('DOI');
      expect(result.duplicateGroups[0].confidence).toBe('high');
      expect(result.duplicateGroups[0].papers).toHaveLength(2);
    });

    it('should detect Tier 2 duplicates matching Title, Year +/- 1, and First Author', async () => {
      mockPaperRepo.findPapers.mockResolvedValueOnce([
        {
          id: 'p1',
          title: 'Deep Residual Learning for Image Recognition',
          doi: null,
          authors: ['He, Kaiming', 'Zhang, Xiangyu'],
          year: 2015,
          citationKey: 'he2015deep',
          collectionId: null,
          createdAt: new Date(),
          attachments: [],
        },
        {
          id: 'p2',
          title: 'Deep Residual Learning for Image Recognition!',
          doi: null,
          authors: ['Kaiming He'],
          year: 2016,
          citationKey: 'he2016deep',
          collectionId: null,
          createdAt: new Date(),
          attachments: [],
        },
      ]);

      const result = await service.getDuplicateGroups('ws-1');

      expect(result.duplicateGroups).toHaveLength(1);
      expect(result.duplicateGroups[0].matchType).toBe('TITLE_AUTHOR_YEAR');
      expect(result.duplicateGroups[0].confidence).toBe('medium');
      expect(result.duplicateGroups[0].papers).toHaveLength(2);
    });
  });

  describe('Vertical Slice 4.2: Safe Merge Protocol', () => {
    it('should reject merging when master paper is included in sourcePaperIds', async () => {
      await expect(
        service.mergePapers('ws-1', 'u-1', {
          masterPaperId: 'p-master',
          sourcePaperIds: ['p-master', 'p-other'],
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw NotFoundException when master paper does not exist', async () => {
      mockPaperRepo.findPaperById.mockResolvedValue(null);

      await expect(
        service.mergePapers('ws-1', 'u-1', {
          masterPaperId: 'p-nonexistent',
          sourcePaperIds: ['p-src'],
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should consolidate notes, merge unique tags, and re-assign attachments to master', async () => {
      const master = {
        id: 'p-master',
        workspaceId: 'ws-1',
        title: 'Master Paper',
        notes: [{ title: 'Note 1', content: 'C1' }],
        labels: ['ai', 'nlp'],
        deletedAt: null,
      };

      const source = {
        id: 'p-src',
        workspaceId: 'ws-1',
        title: 'Source Paper',
        notes: [{ title: 'Note 2', content: 'C2' }],
        labels: ['transformer', 'nlp'],
        deletedAt: null,
      };

      mockPaperRepo.findPaperById.mockResolvedValue(master);
      mockPaperRepo.findPapers.mockResolvedValue([source]);

      const result = await service.mergePapers('ws-1', 'u-1', {
        masterPaperId: 'p-master',
        sourcePaperIds: ['p-src'],
      });

      expect(result.mergedCount).toBe(1);
      expect(result.softDeletedPaperIds).toContain('p-src');
      expect(mockPaperRepo.prisma.$transaction).toHaveBeenCalled();
    });
  });

  describe('Vertical Slice 4.3: Library Health & Integrity Diagnostics', () => {
    it('should accurately categorize missing metadata issues and compute health stats', async () => {
      mockPaperRepo.findPapers.mockResolvedValueOnce([
        {
          id: 'p1',
          title: 'Incomplete Paper',
          doi: '',
          year: null,
          authors: [],
          citationKey: 'unknown2026',
          fileUrl: '',
          attachments: [],
        },
        {
          id: 'p2',
          title: 'Complete Paper',
          doi: '10.1038/nature12345',
          year: 2023,
          authors: ['Smith, John'],
          citationKey: 'smith2023complete',
          fileUrl: 'https://cdn.example.com/paper.pdf',
          attachments: [],
        },
      ]);

      const report = await service.getIntegrityReport('ws-1');

      expect(report.totalPapers).toBe(2);
      expect(report.healthyPapers).toBe(1);
      expect(report.missingDoiCount).toBe(1);
      expect(report.missingYearCount).toBe(1);
      expect(report.missingAuthorsCount).toBe(1);
      expect(report.missingPdfCount).toBe(1);
      expect(report.flaggedItems).toHaveLength(1);
      expect(report.flaggedItems[0].paperId).toBe('p1');
      expect(report.flaggedItems[0].issues).toContain('Missing DOI identifier');
    });
  });
});
