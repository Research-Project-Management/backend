import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { TemplateService } from '@/modules/work-item/template/template.service';
import { TemplateRepository } from '@/modules/work-item/template/template.repository';
import { WorkItemService } from '@/modules/work-item/core/core.service';
import { TaskPriority } from '@prisma/client';

describe('Template Module', () => {
  let service: TemplateService;
  let mockTemplateRepo: Partial<jest.Mocked<TemplateRepository>>;
  let mockWorkItemService: Partial<jest.Mocked<WorkItemService>>;
  let mockEventEmitter: any;

  const mockProjectId = '11111111-1111-1111-1111-111111111111';
  const mockUserId = '22222222-2222-2222-2222-222222222222';
  const mockOtherUserId = '33333333-3333-3333-3333-333333333333';
  const mockTemplateId = '44444444-4444-4444-4444-444444444444';

  const sampleTemplate = {
    id: mockTemplateId,
    name: 'Bug Report Template',
    description: 'Standard bug report layout',
    title: '[BUG] ',
    content: '### Steps to reproduce\n1. \n2. ',
    priority: TaskPriority.high,
    labelIds: ['label-1'],
    assigneeIds: ['user-1'],
    checklists: [{ id: 'chk-1', text: 'Reproduced in staging', checked: false }],
    isDefault: false,
    projectId: mockProjectId,
    authorId: mockUserId,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  };

  beforeEach(() => {
    mockTemplateRepo = {
      resolveProjectId: jest.fn().mockResolvedValue(mockProjectId),
      createTemplate: jest.fn().mockResolvedValue(sampleTemplate),
      unsetOtherDefaults: jest.fn().mockResolvedValue(undefined),
      findTemplatesByProject: jest.fn().mockResolvedValue({
        templates: [sampleTemplate],
        total: 1,
        page: 1,
        limit: 20,
      }),
      findTemplateById: jest.fn().mockResolvedValue(sampleTemplate),
      updateTemplate: jest.fn().mockImplementation((_id, data) =>
        Promise.resolve({ ...sampleTemplate, ...data }),
      ),
      softDeleteTemplate: jest.fn().mockResolvedValue(undefined),
    };

    mockWorkItemService = {
      createTask: jest.fn().mockResolvedValue({
        WorkItem: {
          id: 'task-new-123',
          identifier: 'PROJ-42',
          title: '[BUG] Critical crash',
        },
      } as any),
    };

    mockEventEmitter = {
      emit: jest.fn(),
    };

    service = new TemplateService(
      mockTemplateRepo as unknown as TemplateRepository,
      mockWorkItemService as unknown as WorkItemService,
      mockEventEmitter,
    );
  });

  describe('createTemplate', () => {
    it('should successfully create a template and emit template.created', async () => {
      const result = await service.createTemplate(mockProjectId, mockUserId, {
        name: 'Feature Request Template',
        title: '[FEAT] ',
        priority: TaskPriority.medium,
        isDefault: false,
      });

      expect(result.success).toBe(true);
      expect(result.template).toBeDefined();
      expect(mockTemplateRepo.createTemplate).toHaveBeenCalled();
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'template.created',
        expect.objectContaining({
          templateId: sampleTemplate.id,
          projectId: mockProjectId,
          authorId: mockUserId,
        }),
      );
    });

    it('should unset other defaults when template is marked default', async () => {
      await service.createTemplate(mockProjectId, mockUserId, {
        name: 'Default Template',
        isDefault: true,
      });

      expect(mockTemplateRepo.unsetOtherDefaults).toHaveBeenCalledWith(
        mockProjectId,
        sampleTemplate.id,
      );
    });

    it('should throw NotFoundException if projectId cannot be resolved', async () => {
      (mockTemplateRepo.resolveProjectId as jest.Mock).mockResolvedValueOnce(null);

      await expect(
        service.createTemplate('unknown-proj', mockUserId, { name: 'Test' }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('getProjectTemplates', () => {
    it('should return project templates with pagination', async () => {
      const result = await service.getProjectTemplates(mockProjectId, { page: 1, limit: 10 });
      expect(result.templates).toHaveLength(1);
      expect(result.total).toBe(1);
    });
  });

  describe('getTemplateById', () => {
    it('should return the template when found', async () => {
      const result = await service.getTemplateById(mockProjectId, mockTemplateId);
      expect(result.template.id).toBe(mockTemplateId);
    });

    it('should throw NotFoundException if template does not exist', async () => {
      (mockTemplateRepo.findTemplateById as jest.Mock).mockResolvedValueOnce(null);

      await expect(
        service.getTemplateById(mockProjectId, 'non-existent'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('updateTemplate', () => {
    it('should allow author to update template and emit template.updated', async () => {
      const result = await service.updateTemplate(
        mockProjectId,
        mockTemplateId,
        mockUserId,
        { name: 'Updated Name', isDefault: true },
      );

      expect(result.success).toBe(true);
      expect(mockTemplateRepo.updateTemplate).toHaveBeenCalled();
      expect(mockTemplateRepo.unsetOtherDefaults).toHaveBeenCalled();
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'template.updated',
        expect.objectContaining({ templateId: mockTemplateId }),
      );
    });

    it('should allow project admin to update template even if not author', async () => {
      const result = await service.updateTemplate(
        mockProjectId,
        mockTemplateId,
        mockOtherUserId,
        { name: 'Admin Edit' },
        true, // isAdmin
      );

      expect(result.success).toBe(true);
      expect(mockTemplateRepo.updateTemplate).toHaveBeenCalled();
    });

    it('should reject non-author non-admin update with ForbiddenException', async () => {
      await expect(
        service.updateTemplate(
          mockProjectId,
          mockTemplateId,
          mockOtherUserId,
          { name: 'Hacked' },
          false,
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw NotFoundException if template does not exist', async () => {
      (mockTemplateRepo.findTemplateById as jest.Mock).mockResolvedValueOnce(null);

      await expect(
        service.updateTemplate(mockProjectId, 'missing', mockUserId, { name: 'X' }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('deleteTemplate', () => {
    it('should allow author to delete template and emit template.deleted', async () => {
      const result = await service.deleteTemplate(mockProjectId, mockTemplateId, mockUserId);
      expect(result.success).toBe(true);
      expect(mockTemplateRepo.softDeleteTemplate).toHaveBeenCalledWith(mockTemplateId);
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'template.deleted',
        expect.objectContaining({ templateId: mockTemplateId }),
      );
    });

    it('should allow admin to delete template', async () => {
      const result = await service.deleteTemplate(
        mockProjectId,
        mockTemplateId,
        mockOtherUserId,
        true,
      );
      expect(result.success).toBe(true);
      expect(mockTemplateRepo.softDeleteTemplate).toHaveBeenCalledWith(mockTemplateId);
    });

    it('should reject non-author non-admin deletion', async () => {
      await expect(
        service.deleteTemplate(mockProjectId, mockTemplateId, mockOtherUserId, false),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw NotFoundException if template not found', async () => {
      (mockTemplateRepo.findTemplateById as jest.Mock).mockResolvedValueOnce(null);

      await expect(
        service.deleteTemplate(mockProjectId, 'missing', mockUserId),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('instantiateTemplate', () => {
    it('should instantiate a work item from template and emit template.instantiated', async () => {
      const result = await service.instantiateTemplate(
        mockProjectId,
        mockTemplateId,
        mockUserId,
        {
          title: '[BUG] Override Title',
          columnId: 'col-inprogress',
        },
      );

      expect(result.success).toBe(true);
      expect(result.WorkItem).toBeDefined();
      expect(mockWorkItemService.createTask).toHaveBeenCalledWith(
        mockProjectId,
        mockUserId,
        expect.objectContaining({
          title: '[BUG] Override Title',
          columnId: 'col-inprogress',
        }),
      );
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'template.instantiated',
        expect.objectContaining({
          templateId: mockTemplateId,
          taskId: 'task-new-123',
        }),
      );
    });

    it('should throw NotFoundException if template does not exist', async () => {
      (mockTemplateRepo.findTemplateById as jest.Mock).mockResolvedValueOnce(null);

      await expect(
        service.instantiateTemplate(mockProjectId, 'missing', mockUserId, {}),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
