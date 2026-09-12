import { NotFoundException } from '@nestjs/common';
import { ExportService } from '@/modules/work-item/export/export.service';
import { ExportFormat } from '@/modules/work-item/export/dto/export-query.dto';
import { exportTasksToCsv } from '@/modules/work-item/export/utils/csv-exporter.util';
import { PrismaService } from '@/core/database/prisma.service';
import { TaskPriority } from '@prisma/client';

describe('Export Module', () => {
  let service: ExportService;
  let mockPrisma: any;

  const mockProjectId = '11111111-1111-1111-1111-111111111111';
  const mockWorkspaceId = '22222222-2222-2222-2222-222222222222';

  const sampleTasks: any[] = [
    {
      id: 'task-1',
      identifier: 'PROJ-1',
      title: 'Fix authentication bug, with comma',
      description: 'Multi-line\ndescription with "quotes"',
      columnId: 'todo',
      priority: TaskPriority.high,
      completed: false,
      dueDate: new Date('2026-10-01T00:00:00.000Z'),
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
      updatedAt: new Date('2026-09-02T00:00:00.000Z'),
      author: { id: 'u-1', name: 'Author One', email: 'author@test.com' },
      assignee: { id: 'u-2', name: 'Assignee Two', email: 'assignee@test.com' },
    },
    {
      id: 'task-2',
      identifier: 'PROJ-2',
      title: 'Write docs',
      description: 'Simple description',
      columnId: 'done',
      priority: TaskPriority.low,
      completed: true,
      dueDate: null,
      createdAt: new Date('2026-09-03T00:00:00.000Z'),
      updatedAt: new Date('2026-09-04T00:00:00.000Z'),
      author: { id: 'u-1', name: 'Author One', email: 'author@test.com' },
      assignee: null,
    },
  ];

  beforeEach(() => {
    mockPrisma = {
      project: {
        findUnique: jest.fn().mockResolvedValue({
          id: mockProjectId,
          name: 'Research Paper',
          identifier: 'RESP',
        }),
      },
      workspace: {
        findUnique: jest.fn().mockResolvedValue({
          id: mockWorkspaceId,
          name: 'Main Lab',
          slug: 'main-lab',
        }),
      },
      workItem: {
        findMany: jest.fn().mockResolvedValue(sampleTasks),
      },
    };

    service = new ExportService(mockPrisma as PrismaService);
  });

  describe('exportTasksToCsv utility', () => {
    it('should generate valid CSV with headers and escaped fields', () => {
      const csv = exportTasksToCsv(sampleTasks);
      expect(csv).toContain('ID,Identifier,Title,Description,State / Column,Priority,Completed');
      expect(csv).toContain('PROJ-1');
      expect(csv).toContain('"Fix authentication bug, with comma"');
      expect(csv).toContain('Multi-line\ndescription with ""quotes""');
      expect(csv).toContain('Assignee Two');
    });

    it('should return only headers when WorkItem list is empty', () => {
      const csv = exportTasksToCsv([]);
      expect(csv).toContain('ID,Identifier,Title,Description,State / Column,Priority,Completed');
    });
  });

  describe('exportProjectWorkItems', () => {
    it('should export project tasks to CSV by default', async () => {
      const result = await service.exportProjectWorkItems(mockProjectId, {});

      expect(result.contentType).toBe('text/csv; charset=utf-8');
      expect(result.filename).toMatch(/^resp-export-\d{4}-\d{2}-\d{2}\.csv$/);
      expect(result.data).toContain('PROJ-1');
      expect(mockPrisma.workItem.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ projectId: mockProjectId, deletedAt: null }),
        }),
      );
    });

    it('should export project tasks to JSON when requested', async () => {
      const result = await service.exportProjectWorkItems(mockProjectId, {
        format: ExportFormat.JSON,
      });

      expect(result.contentType).toBe('application/json; charset=utf-8');
      expect(result.filename).toMatch(/^resp-export-\d{4}-\d{2}-\d{2}\.json$/);
      const parsed = JSON.parse(result.data);
      expect(parsed).toHaveLength(2);
      expect(parsed[0].identifier).toBe('PROJ-1');
    });

    it('should filter tasks by cycleId, columnId, priority, assigneeId, completed and search', async () => {
      await service.exportProjectWorkItems(mockProjectId, {
        cycleId: 'cycle-1',
        columnId: 'todo',
        priority: 'high',
        assigneeId: 'u-2',
        completed: false,
        search: 'auth',
      });

      expect(mockPrisma.workItem.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            projectId: mockProjectId,
            cycleId: 'cycle-1',
            columnId: 'todo',
            priority: 'high',
            assigneeId: 'u-2',
            completed: false,
            OR: [
              { title: { contains: 'auth', mode: 'insensitive' } },
              { description: { contains: 'auth', mode: 'insensitive' } },
            ],
          }),
        }),
      );
    });

    it('should throw NotFoundException if project not found', async () => {
      mockPrisma.project.findUnique.mockResolvedValueOnce(null);

      await expect(
        service.exportProjectWorkItems('unknown-id', {}),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
