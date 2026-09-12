import { DraftService } from '@/modules/work-item/draft/draft.service';
import { DraftRepository } from '@/modules/work-item/draft/draft.repository';
import { WorkItemService } from '@/modules/work-item/core/work-item.service';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

describe('Draft Module', () => {
  let service: DraftService;
  let mockRepo: {
    create: jest.Mock;
    findById: jest.Mock;
    findUserDrafts: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
  };
  let mockWorkItemService: {
    createTask: jest.Mock;
  };
  let mockEventEmitter: { emit: jest.Mock };

  const draftId = 'draft-1';
  const authorId = 'user-1';
  const projectId = 'project-1';

  beforeEach(() => {
    mockRepo = {
      create: jest.fn(),
      findById: jest.fn(),
      findUserDrafts: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    };
    mockWorkItemService = {
      createTask: jest.fn(),
    };
    mockEventEmitter = {
      emit: jest.fn(),
    };
    service = new DraftService(
      mockRepo as unknown as DraftRepository,
      mockWorkItemService as unknown as WorkItemService,
      mockEventEmitter as unknown as EventEmitter2,
    );
  });

  describe('createDraft', () => {
    it('should create draft and emit event', async () => {
      const mockCreated = { id: draftId, projectId, title: 'Draft Task' };
      mockRepo.create.mockResolvedValue(mockCreated);

      const result = await service.createDraft({ projectId, title: 'Draft Task' }, authorId);
      expect(result).toBe(mockCreated);
      expect(mockRepo.create).toHaveBeenCalledWith(
        { projectId, title: 'Draft Task' },
        authorId,
      );
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'draft.created',
        expect.objectContaining({ draftId, authorId, projectId }),
      );
    });
  });

  describe('getDraft', () => {
    it('should throw NotFoundException if draft not found', async () => {
      mockRepo.findById.mockResolvedValue(null);
      await expect(service.getDraft(draftId, authorId)).rejects.toThrow(NotFoundException);
    });

    it('should return draft if found', async () => {
      const mockDraft = { id: draftId, title: 'My Draft', authorId };
      mockRepo.findById.mockResolvedValue(mockDraft);

      const result = await service.getDraft(draftId, authorId);
      expect(result).toBe(mockDraft);
    });
  });

  describe('getUserDrafts', () => {
    it('should query drafts with pagination defaults', async () => {
      mockRepo.findUserDrafts.mockResolvedValue({ drafts: [], total: 0 });
      await service.getUserDrafts(authorId, {});
      expect(mockRepo.findUserDrafts).toHaveBeenCalledWith(
        authorId,
        { projectId: undefined, search: undefined },
        0,
        50,
      );
    });

    it('should honor custom page and limit', async () => {
      mockRepo.findUserDrafts.mockResolvedValue({ drafts: [], total: 0 });
      await service.getUserDrafts(authorId, { page: 2, limit: 10, projectId });
      expect(mockRepo.findUserDrafts).toHaveBeenCalledWith(
        authorId,
        { projectId, search: undefined },
        10,
        10,
      );
    });
  });

  describe('updateDraft', () => {
    it('should throw NotFoundException if draft does not exist', async () => {
      mockRepo.findById.mockResolvedValue(null);
      await expect(
        service.updateDraft(draftId, { title: 'Updated' }, authorId),
      ).rejects.toThrow(NotFoundException);
    });

    it('should update draft if found', async () => {
      mockRepo.findById.mockResolvedValue({ id: draftId });
      mockRepo.update.mockResolvedValue({ id: draftId, title: 'Updated' });

      const result = await service.updateDraft(draftId, { title: 'Updated' }, authorId);
      expect(result.title).toBe('Updated');
    });
  });

  describe('publishDraft', () => {
    it('should throw NotFoundException if draft does not exist', async () => {
      mockRepo.findById.mockResolvedValue(null);
      await expect(service.publishDraft(draftId, {}, authorId)).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException if draft has no projectId and none provided in dto', async () => {
      mockRepo.findById.mockResolvedValue({ id: draftId, projectId: null });
      await expect(service.publishDraft(draftId, {}, authorId)).rejects.toThrow(BadRequestException);
    });

    it('should convert draft to work item, delete draft, and emit event', async () => {
      mockRepo.findById.mockResolvedValue({
        id: draftId,
        projectId,
        title: 'Ready for Review',
        content: 'Draft content',
        columnId: 'col-1',
        priority: 'high',
        labels: ['tag1'],
      });
      mockWorkItemService.createTask.mockResolvedValue({
        task: { id: 'task-real-1', identifier: 'FLUX-101' },
      });
      mockRepo.delete.mockResolvedValue({ count: 1 });

      const result = await service.publishDraft(draftId, {}, authorId);
      expect(mockWorkItemService.createTask).toHaveBeenCalledWith(
        projectId,
        authorId,
        expect.objectContaining({
          title: 'Ready for Review',
          content: 'Draft content',
          priority: 'high',
        }),
      );
      expect(mockRepo.delete).toHaveBeenCalledWith(draftId, authorId);
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'draft.published',
        expect.objectContaining({ draftId, taskId: 'task-real-1', projectId, authorId }),
      );
      expect(result).toEqual({ task: { id: 'task-real-1', identifier: 'FLUX-101' } });
    });
  });

  describe('duplicateDraft', () => {
    it('should throw NotFoundException if draft not found', async () => {
      mockRepo.findById.mockResolvedValue(null);
      await expect(service.duplicateDraft(draftId, authorId)).rejects.toThrow(NotFoundException);
    });

    it('should duplicate draft with (Copy) suffix and emit event', async () => {
      const existingDraft = {
        id: draftId,
        title: 'Original Draft',
        content: 'Original content',
        description: 'Original description',
        priority: 'high',
        projectId,
        labels: ['tag1'],
      };
      const clonedDraft = {
        id: 'draft-copy-1',
        title: 'Original Draft (Copy)',
        content: 'Original content',
        description: 'Original description',
        priority: 'high',
        projectId,
        labels: ['tag1'],
      };

      mockRepo.findById.mockResolvedValue(existingDraft);
      mockRepo.create.mockResolvedValue(clonedDraft);

      const result = await service.duplicateDraft(draftId, authorId);
      expect(mockRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Original Draft (Copy)',
          content: 'Original content',
          priority: 'high',
          projectId,
        }),
        authorId,
      );
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'draft.created',
        expect.objectContaining({ draftId: 'draft-copy-1', authorId, projectId }),
      );
      expect(result).toEqual(clonedDraft);
    });
  });

  describe('deleteDraft', () => {
    it('should throw NotFoundException if draft not found', async () => {
      mockRepo.findById.mockResolvedValue(null);
      await expect(service.deleteDraft(draftId, authorId)).rejects.toThrow(NotFoundException);
    });

    it('should delete draft and return success', async () => {
      mockRepo.findById.mockResolvedValue({ id: draftId });
      mockRepo.delete.mockResolvedValue({ count: 1 });

      const result = await service.deleteDraft(draftId, authorId);
      expect(result).toEqual({ success: true, id: draftId });
    });
  });
});
