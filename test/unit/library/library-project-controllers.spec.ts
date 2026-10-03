import { ProjectItemController } from '@/modules/library/catalog/items.controller';
import { ProjectCollectionController } from '@/modules/library/catalog/collections.controller';
import { ProjectItemCurationController } from '@/modules/library/catalog/item-curation.controller';
import { ProjectSavedSearchesController } from '@/modules/library/catalog/saved-searches.controller';
import {
  ProjectStateController,
  ProjectStateBatchController,
} from '@/modules/library/catalog/state.controller';
import { ProjectAttachmentController } from '@/modules/library/extraction/attachments.controller';
import { ProjectIngestionController } from '@/modules/library/ingestion/ingestion.controller';

describe('Project-Scoped Library Controllers (Strict UUID & Project Isolation)', () => {
  const sampleProjectId = '11111111-2222-4333-8444-555555555555';
  const sampleUserId = 'user-test-1';
  const sampleItemId = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';

  describe('ProjectItemController', () => {
    let controller: ProjectItemController;
    let mockListUseCase: { execute: jest.Mock };
    let mockGetUseCase: { execute: jest.Mock };
    let mockCreateUseCase: { execute: jest.Mock };

    beforeEach(() => {
      mockListUseCase = {
        execute: jest.fn().mockResolvedValue({
          items: [{ id: sampleItemId, title: 'Project Paper' }],
          pagination: { hasNextPage: false, totalCount: 1 },
        }),
      };
      mockGetUseCase = {
        execute: jest.fn().mockResolvedValue({
          id: sampleItemId,
          title: 'Project Paper',
        }),
      };
      mockCreateUseCase = {
        execute: jest.fn().mockResolvedValue({
          id: sampleItemId,
          title: 'New Paper',
        }),
      };

      controller = new ProjectItemController(
        mockCreateUseCase as any,
        {} as any,
        {} as any,
        {} as any,
        mockGetUseCase as any,
        mockListUseCase as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
      );
    });

    it('should pass projectId strictly to listItemsUseCase', async () => {
      const result = await controller.listItems(sampleUserId, sampleProjectId, {
        view: 'all',
      });

      expect(mockListUseCase.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: sampleUserId,
          projectId: sampleProjectId,
          view: 'all',
        }),
      );
      expect(result.items.length).toBe(1);
    });

    it('should pass projectId strictly to getItemUseCase', async () => {
      const item = await controller.getItem(
        sampleItemId,
        sampleUserId,
        sampleProjectId,
      );

      expect(mockGetUseCase.execute).toHaveBeenCalledWith({
        userId: sampleUserId,
        itemId: sampleItemId,
        projectId: sampleProjectId,
      });
      expect(item.id).toBe(sampleItemId);
    });

    it('should pass projectId strictly to createItemUseCase', async () => {
      await controller.createItem(sampleUserId, sampleProjectId, {
        title: 'New Paper',
        itemType: 'journalArticle',
      });

      expect(mockCreateUseCase.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: sampleUserId,
          projectId: sampleProjectId,
          title: 'New Paper',
        }),
      );
    });
  });

  describe('ProjectCollectionController', () => {
    let controller: ProjectCollectionController;
    let mockGetCollectionsUseCase: { execute: jest.Mock };

    beforeEach(() => {
      mockGetCollectionsUseCase = {
        execute: jest
          .fn()
          .mockResolvedValue([{ id: 'col-1', name: 'Project Collection' }]),
      };

      controller = new ProjectCollectionController(
        mockGetCollectionsUseCase as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
      );
    });

    it('should list project collections with strict projectId', async () => {
      const result = await controller.getCollections(
        sampleUserId,
        sampleProjectId,
      );

      expect(mockGetCollectionsUseCase.execute).toHaveBeenCalledWith({
        userId: sampleUserId,
        projectId: sampleProjectId,
      });
      expect(result).toHaveLength(1);
    });
  });

  describe('ProjectStateController & ProjectStateBatchController', () => {
    let stateController: ProjectStateController;
    let batchController: ProjectStateBatchController;
    let mockStateService: {
      getState: jest.Mock;
      getBatchStates: jest.Mock;
    };

    beforeEach(() => {
      mockStateService = {
        getState: jest.fn().mockResolvedValue({
          isStarred: true,
          readStatus: 'completed',
        }),
        getBatchStates: jest.fn().mockResolvedValue({
          [sampleItemId]: { isStarred: true, readStatus: 'completed' },
        }),
      };

      stateController = new ProjectStateController(mockStateService as any);
      batchController = new ProjectStateBatchController(
        mockStateService as any,
      );
    });

    it('should query state scoped strictly to projectId', async () => {
      const state = await stateController.getState(
        sampleUserId,
        sampleItemId,
        sampleProjectId,
      );

      expect(mockStateService.getState).toHaveBeenCalledWith(
        sampleUserId,
        sampleItemId,
        sampleProjectId,
      );
      expect(state.isStarred).toBe(true);
    });

    it('should query batch states scoped strictly to projectId', async () => {
      const states = await batchController.getBatchStates(
        sampleUserId,
        { itemIds: [sampleItemId] },
        sampleProjectId,
      );

      expect(mockStateService.getBatchStates).toHaveBeenCalledWith(
        sampleUserId,
        [sampleItemId],
        sampleProjectId,
      );
      expect(states[sampleItemId]).toBeDefined();
    });
  });

  describe('ProjectAttachmentController', () => {
    let controller: ProjectAttachmentController;
    let mockGetItemAttachmentsUseCase: { execute: jest.Mock };

    beforeEach(() => {
      mockGetItemAttachmentsUseCase = {
        execute: jest.fn().mockResolvedValue({
          attachments: [{ id: 'att-1', filename: 'project-paper.pdf' }],
          total: 1,
        }),
      };

      controller = new ProjectAttachmentController(
        {} as any,
        {} as any,
        mockGetItemAttachmentsUseCase as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
      );
    });

    it('should fetch item attachments within project scope', async () => {
      const result = await controller.getItemAttachments(
        sampleUserId,
        sampleItemId,
        sampleProjectId,
      );

      expect(mockGetItemAttachmentsUseCase.execute).toHaveBeenCalledWith({
        itemId: sampleItemId,
        userId: sampleUserId,
        projectId: sampleProjectId,
      });
      expect(result.attachments).toHaveLength(1);
    });
  });

  describe('ProjectIngestionController', () => {
    let controller: ProjectIngestionController;
    let mockSubmitIngestionUseCase: { execute: jest.Mock };

    beforeEach(() => {
      mockSubmitIngestionUseCase = {
        execute: jest.fn().mockResolvedValue({
          runId: 'run-project-1',
          status: 'ACCEPTED',
        }),
      };

      controller = new ProjectIngestionController(
        mockSubmitIngestionUseCase as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
      );
    });

    it('should submit ingestion scoped to projectId', async () => {
      const result = await controller.submit(
        sampleUserId,
        'idemp-proj-1',
        {
          kind: 'IDENTIFIER',
          identifierType: 'DOI',
          value: '10.1038/project.paper',
        } as any,
        sampleProjectId,
      );

      expect(mockSubmitIngestionUseCase.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: sampleUserId,
          idempotencyKey: 'idemp-proj-1',
          projectId: sampleProjectId,
        }),
      );
      expect(result.runId).toBe('run-project-1');
    });
  });
});
