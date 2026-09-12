import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  LabelService,
  DEFAULT_LABEL_PALETTE,
} from '@/modules/work-item/label/label.service';
import { LabelRepository } from '@/modules/work-item/label/label.repository';
import { LabelWithChildren } from '@/modules/work-item/label/types/label.types';
import { LabelType } from '@prisma/client';

describe('Work Item Label Module', () => {
  let service: LabelService;
  let mockLabelRepo: Partial<jest.Mocked<LabelRepository>>;
  let mockPrisma: any;
  let mockCache: any;

  const mockProjectId = '11111111-1111-1111-1111-111111111111';
  const mockWorkspaceId = '22222222-2222-2222-2222-222222222222';
  const mockUserId = '33333333-3333-3333-3333-333333333333';

  beforeEach(() => {
    mockLabelRepo = {
      findProjectLabels: jest.fn(),
      findWorkspaceLabels: jest.fn(),
      findById: jest.fn(),
      findByNameInProject: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      reorder: jest.fn(),
      detachFromTasks: jest.fn().mockResolvedValue(2),
      detachMultipleFromTasks: jest.fn().mockResolvedValue(2),
    };

    mockPrisma = {
      project: {
        findUnique: jest.fn().mockResolvedValue({
          id: mockProjectId,
          workspaceId: mockWorkspaceId,
        }),
      },
      label: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      workspace: {
        findUnique: jest.fn().mockResolvedValue({ id: mockWorkspaceId }),
        findFirst: jest.fn().mockResolvedValue({ id: mockWorkspaceId }),
      },
    };

    mockCache = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(undefined),
    };

    service = new LabelService(
      mockLabelRepo as unknown as LabelRepository,
      mockPrisma as any,
      mockCache,
    );
  });

  describe('createProjectLabel', () => {
    it('should create a project label with custom color and default sortOrder', async () => {
      (mockLabelRepo.findByNameInProject as jest.Mock).mockResolvedValue(null);
      (mockLabelRepo.create as jest.Mock).mockImplementation((data) =>
        Promise.resolve({
          id: 'label-1',
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        }),
      );

      const result = await service.createProjectLabel(
        mockProjectId,
        mockUserId,
        {
          name: 'Feature',
          color: '#10b981',
          description: 'New feature development',
        },
      );

      expect(result.label).toBeDefined();
      expect(result.label.name).toBe('Feature');
      expect(result.label.color).toBe('#10b981');
      expect(result.label.projectId).toBe(mockProjectId);
      expect(result.label.workspaceId).toBe(mockWorkspaceId);
      expect(result.label.sortOrder).toBe(10000);
      expect(mockCache.del).toHaveBeenCalled();
    });

    it('should assign a preset color from default palette if color is omitted', async () => {
      (mockLabelRepo.findByNameInProject as jest.Mock).mockResolvedValue(null);
      (mockLabelRepo.create as jest.Mock).mockImplementation((data) =>
        Promise.resolve({ id: 'label-2', ...data }),
      );

      const result = await service.createProjectLabel(
        mockProjectId,
        mockUserId,
        {
          name: 'Backend',
        },
      );

      expect(DEFAULT_LABEL_PALETTE).toContain(result.label.color);
    });

    it('should reject duplicate label name in the same project with ConflictException', async () => {
      (mockLabelRepo.findByNameInProject as jest.Mock).mockResolvedValue({
        id: 'existing-label',
        name: 'Bug',
      });

      await expect(
        service.createProjectLabel(mockProjectId, mockUserId, { name: 'Bug' }),
      ).rejects.toThrow(ConflictException);
    });

    it('should throw NotFoundException if project does not exist', async () => {
      mockPrisma.project.findUnique.mockResolvedValue(null);

      await expect(
        service.createProjectLabel('unknown-project', mockUserId, {
          name: 'Test',
        }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('Hierarchical / Nested Sub-labels', () => {
    it('should allow creating a sub-label with valid parentId in the same project', async () => {
      const parentLabel: LabelWithChildren = {
        id: 'parent-1',
        name: 'Platform',
        color: '#6366f1',
        description: null,
        sortOrder: 10000,
        type: LabelType.task,
        parentId: null,
        projectId: mockProjectId,
        workspaceId: mockWorkspaceId,
        createdById: mockUserId,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      (mockLabelRepo.findById as jest.Mock).mockResolvedValue(parentLabel);
      (mockLabelRepo.findByNameInProject as jest.Mock).mockResolvedValue(null);
      (mockLabelRepo.create as jest.Mock).mockImplementation((data) =>
        Promise.resolve({ id: 'child-1', ...data }),
      );

      const result = await service.createProjectLabel(
        mockProjectId,
        mockUserId,
        {
          name: 'iOS',
          parentId: 'parent-1',
        },
      );

      expect(result.label.parentId).toBe('parent-1');
      expect(mockLabelRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ parentId: 'parent-1' }),
      );
    });

    it('should throw BadRequestException if parent label belongs to another project', async () => {
      (mockLabelRepo.findById as jest.Mock).mockResolvedValue({
        id: 'foreign-parent',
        projectId: 'other-project-uuid',
      });

      await expect(
        service.createProjectLabel(mockProjectId, mockUserId, {
          name: 'Android',
          parentId: 'foreign-parent',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException if target parent is already a sub-label (Strict 1-level)', async () => {
      (mockLabelRepo.findById as jest.Mock).mockResolvedValue({
        id: 'sub-parent-id',
        name: 'Existing Sub-label',
        projectId: mockProjectId,
        parentId: 'root-id', // Already a child!
      });

      await expect(
        service.createProjectLabel(mockProjectId, mockUserId, {
          name: 'Grandchild Label',
          parentId: 'sub-parent-id',
        }),
      ).rejects.toThrow(/Nesting is limited to 1 level deep/);
    });

    it('should prevent label from setting itself as parent', async () => {
      (mockLabelRepo.findById as jest.Mock).mockResolvedValue({
        id: 'label-self',
        name: 'Self Label',
        projectId: mockProjectId,
        workspaceId: mockWorkspaceId,
      });

      await expect(
        service.updateProjectLabel(mockProjectId, 'label-self', {
          parentId: 'label-self',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException if label already has sub-labels and is being nested', async () => {
      (mockLabelRepo.findById as jest.Mock).mockResolvedValue({
        id: 'parent-with-children',
        name: 'Platform',
        projectId: mockProjectId,
        children: [{ id: 'child-1', name: 'iOS' }],
      });

      await expect(
        service.updateProjectLabel(mockProjectId, 'parent-with-children', {
          parentId: 'target-parent-id',
        }),
      ).rejects.toThrow(/Cannot nest a label that already contains sub-labels/);
    });

    it('should detect and prevent circular hierarchy', async () => {
      // Structure: A (label-a) is parent of B (label-b)
      // Attempting to set A's parent to B should fail!
      (mockLabelRepo.findById as jest.Mock).mockImplementation((id: string) => {
        if (id === 'label-a') {
          return Promise.resolve({
            id: 'label-a',
            name: 'A',
            projectId: mockProjectId,
            workspaceId: mockWorkspaceId,
            parentId: null,
          });
        }
        if (id === 'label-b') {
          return Promise.resolve({
            id: 'label-b',
            name: 'B',
            projectId: mockProjectId,
            workspaceId: mockWorkspaceId,
            parentId: 'label-a', // B's parent is A
          });
        }
        return Promise.resolve(null);
      });

      await expect(
        service.updateProjectLabel(mockProjectId, 'label-a', {
          parentId: 'label-b',
        }),
      ).rejects.toThrow(
        /Circular hierarchy detected|Nesting is limited to 1 level deep/,
      );
    });
  });

  describe('getProjectLabels', () => {
    it('should return hierarchical labels from repository and cache results', async () => {
      const mockLabels: LabelWithChildren[] = [
        {
          id: 'label-1',
          name: 'Platform',
          color: '#3b82f6',
          description: null,
          sortOrder: 10000,
          type: LabelType.task,
          parentId: null,
          projectId: mockProjectId,
          workspaceId: mockWorkspaceId,
          createdById: mockUserId,
          createdAt: new Date(),
          updatedAt: new Date(),
          children: [
            {
              id: 'label-2',
              name: 'iOS',
              color: '#3b82f6',
              description: null,
              sortOrder: 10001,
              type: LabelType.task,
              parentId: 'label-1',
              projectId: mockProjectId,
              workspaceId: mockWorkspaceId,
              createdById: mockUserId,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ],
        },
      ];

      (mockLabelRepo.findProjectLabels as jest.Mock).mockResolvedValue(
        mockLabels,
      );

      const result = await service.getProjectLabels(mockProjectId);

      expect(result.labels).toHaveLength(1);
      expect(result.labels[0].children).toHaveLength(1);
      expect(mockCache.set).toHaveBeenCalled();
    });
  });

  describe('updateProjectLabel', () => {
    it('should successfully update label properties', async () => {
      (mockLabelRepo.findById as jest.Mock).mockResolvedValue({
        id: 'label-1',
        name: 'Old Name',
        color: '#111111',
        projectId: mockProjectId,
        workspaceId: mockWorkspaceId,
      });
      (mockLabelRepo.update as jest.Mock).mockResolvedValue({
        id: 'label-1',
        name: 'New Name',
        color: '#222222',
        projectId: mockProjectId,
      });

      const result = await service.updateProjectLabel(
        mockProjectId,
        'label-1',
        {
          name: 'New Name',
          color: '#222222',
        },
      );

      expect(result.label.name).toBe('New Name');
      expect(mockLabelRepo.update).toHaveBeenCalledWith('label-1', {
        name: 'New Name',
        color: '#222222',
      });
    });

    it('should disallow renaming if another label with that name already exists in project', async () => {
      (mockLabelRepo.findById as jest.Mock).mockResolvedValue({
        id: 'label-1',
        name: 'Old Name',
        projectId: mockProjectId,
        workspaceId: mockWorkspaceId,
      });
      (mockLabelRepo.findByNameInProject as jest.Mock).mockResolvedValue({
        id: 'label-2',
        name: 'Existing Name',
      });

      await expect(
        service.updateProjectLabel(mockProjectId, 'label-1', {
          name: 'Existing Name',
        }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('deleteProjectLabel (Safe Cascade Detachment)', () => {
    it('should detach label and all nested sub-labels from all project tasks and delete parent', async () => {
      (mockLabelRepo.findById as jest.Mock).mockResolvedValue({
        id: 'parent-group',
        name: 'Architecture',
        projectId: mockProjectId,
        workspaceId: mockWorkspaceId,
        children: [
          { id: 'child-1', name: 'Backend' },
          { id: 'child-2', name: 'Frontend' },
        ],
      });
      (mockLabelRepo.delete as jest.Mock).mockResolvedValue({
        id: 'parent-group',
      });

      const result = await service.deleteProjectLabel(
        mockProjectId,
        'parent-group',
      );

      expect(result.message).toContain('deleted successfully');
      expect(mockLabelRepo.detachMultipleFromTasks).toHaveBeenCalledWith(
        mockProjectId,
        ['parent-group', 'child-1', 'child-2'],
        ['Architecture', 'Backend', 'Frontend'],
      );
      expect(mockLabelRepo.delete).toHaveBeenCalledWith('parent-group');
      expect(mockCache.del).toHaveBeenCalled();
    });

    it('should throw ForbiddenException if label does not belong to project', async () => {
      (mockLabelRepo.findById as jest.Mock).mockResolvedValue({
        id: 'label-foreign',
        name: 'Foreign',
        projectId: 'different-project',
        workspaceId: mockWorkspaceId,
      });

      await expect(
        service.deleteProjectLabel(mockProjectId, 'label-foreign'),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('reorderProjectLabels', () => {
    it('should reorder labels and clear cache', async () => {
      const updates = [
        { id: 'label-1', sortOrder: 1000 },
        { id: 'label-2', sortOrder: 2000 },
      ];

      const result = await service.reorderProjectLabels(mockProjectId, {
        labels: updates,
      });

      expect(result.message).toContain('reordered successfully');
      expect(mockLabelRepo.reorder).toHaveBeenCalledWith(
        mockProjectId,
        updates,
      );
      expect(mockCache.del).toHaveBeenCalled();
    });
  });

  describe('importProjectLabels (Bulk CSV Import)', () => {
    it('should import new labels, skip duplicates case-insensitively, and return stats', async () => {
      (mockLabelRepo.findProjectLabels as jest.Mock).mockResolvedValue([
        { id: 'existing-1', name: 'Backend', children: [] },
      ]);
      (mockLabelRepo.create as jest.Mock).mockImplementation((data) =>
        Promise.resolve({ id: `imported-${Date.now()}`, ...data }),
      );

      const result = await service.importProjectLabels(
        mockProjectId,
        mockUserId,
        {
          labels: [
            { name: 'Frontend', color: '#3b82f6', description: 'UI layer' },
            { name: 'backend', color: '#10b981' }, // Duplicate case-insensitive -> skip
            { name: 'Frontend', color: '#ffffff' }, // Duplicate within batch -> skip
            { name: '   ' }, // Invalid -> failed
            { name: 'DevOps' }, // Valid with default palette color
          ],
        },
      );

      expect(result.created).toBe(2); // Frontend, DevOps
      expect(result.skipped).toBe(2); // backend, duplicate Frontend
      expect(result.failed).toBe(1); // empty name
      expect(result.labels).toHaveLength(2);
      expect(mockCache.del).toHaveBeenCalled();
    });
  });

  describe('Legacy Workspace-Level Compatibility', () => {
    it('should route createLabel with projectId to createProjectLabel', async () => {
      (mockLabelRepo.findByNameInProject as jest.Mock).mockResolvedValue(null);
      (mockLabelRepo.create as jest.Mock).mockImplementation((data) =>
        Promise.resolve({ id: 'legacy-created', ...data }),
      );

      const result = await service.createLabel(mockWorkspaceId, mockUserId, {
        name: 'Legacy Tag',
        projectId: mockProjectId,
      });

      expect(result.label.projectId).toBe(mockProjectId);
    });

    it('should return labels for workspace when no projectId is provided', async () => {
      (mockLabelRepo.findWorkspaceLabels as jest.Mock).mockResolvedValue([
        { id: 'ws-label-1', name: 'Global Label' },
      ]);

      const result = await service.getLabels(mockWorkspaceId);

      expect(result.labels).toHaveLength(1);
      expect(mockLabelRepo.findWorkspaceLabels).toHaveBeenCalledWith(
        mockWorkspaceId,
        undefined,
      );
    });
  });
});
