import { ProjectItemController } from '@/modules/library/catalog/controllers/items.controller';
import { ProjectCollectionController } from '@/modules/library/catalog/controllers/collections.controller';
import { ProjectItemCurationController } from '@/modules/library/catalog/controllers/item-curation.controller';
import { ProjectSavedSearchesController } from '@/modules/library/catalog/controllers/saved-searches.controller';
import {
  ProjectStateController,
  ProjectStateBatchController,
} from '@/modules/library/catalog/controllers/state.controller';
import { ProjectAttachmentController } from '@/modules/library/extraction/controllers/attachments.controller';
import { ProjectIngestionController } from '@/modules/library/ingestion/controllers/ingestion.controller';

describe('Project-Scoped Library Controllers (Strict UUID & Project Isolation)', () => {
  const sampleProjectId = '11111111-2222-4333-8444-555555555555';
  const sampleUserId = 'user-test-1';
  const sampleItemId = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';

  describe('ProjectItemController', () => {
    let controller: ProjectItemController;
    let mockItemService: {
      listItems: jest.Mock;
      getItem: jest.Mock;
      createItem: jest.Mock;
    };

    beforeEach(() => {
      mockItemService = {
        listItems: jest.fn().mockResolvedValue({
          items: [{ id: sampleItemId, title: 'Project Paper' }],
          meta: { hasNextPage: false, totalCount: 1 },
        }),
        getItem: jest.fn().mockResolvedValue({
          id: sampleItemId,
          title: 'Project Paper',
        }),
        createItem: jest.fn().mockResolvedValue({
          id: sampleItemId,
          title: 'New Paper',
        }),
      };

      controller = new ProjectItemController(mockItemService as any);
    });

    it('should pass projectId strictly to listItems', async () => {
      const result = await controller.listItems(sampleUserId, sampleProjectId, {
        view: 'all',
      });

      expect(mockItemService.listItems).toHaveBeenCalledWith(
        sampleUserId,
        expect.objectContaining({
          projectId: sampleProjectId,
          view: 'all',
        }),
      );
      expect(result.items.length).toBe(1);
    });

    it('should pass projectId strictly to getItem', async () => {
      const item = await controller.getItem(
        sampleItemId,
        sampleUserId,
        sampleProjectId,
      );

      expect(mockItemService.getItem).toHaveBeenCalledWith(
        sampleUserId,
        sampleItemId,
        sampleProjectId,
      );
      expect(item.id).toBe(sampleItemId);
    });

    it('should pass projectId strictly to createItem', async () => {
      await controller.createItem(sampleUserId, sampleProjectId, {
        title: 'New Paper',
        itemType: 'journalArticle',
      });

      expect(mockItemService.createItem).toHaveBeenCalledWith(
        sampleUserId,
        expect.objectContaining({
          title: 'New Paper',
        }),
        expect.objectContaining({
          projectId: sampleProjectId,
        }),
        sampleProjectId,
      );
    });
  });

  describe('ProjectCollectionController', () => {
    let controller: ProjectCollectionController;
    let mockCollectionsService: {
      getCollections: jest.Mock;
    };

    beforeEach(() => {
      mockCollectionsService = {
        getCollections: jest
          .fn()
          .mockResolvedValue([{ id: 'col-1', name: 'Project Collection' }]),
      };

      controller = new ProjectCollectionController(
        mockCollectionsService as any,
      );
    });

    it('should list project collections with strict projectId', async () => {
      const result = await controller.getCollections(
        sampleUserId,
        sampleProjectId,
      );

      expect(mockCollectionsService.getCollections).toHaveBeenCalledWith(
        sampleUserId,
        sampleProjectId,
      );
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
        sampleProjectId,
        { itemIds: [sampleItemId] },
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
    let mockAttachmentsService: {
      getItemAttachments: jest.Mock;
    };

    beforeEach(() => {
      mockAttachmentsService = {
        getItemAttachments: jest.fn().mockResolvedValue({
          attachments: [{ id: 'att-1', filename: 'project-paper.pdf' }],
          total: 1,
        }),
      };

      controller = new ProjectAttachmentController(
        mockAttachmentsService as any,
      );
    });

    it('should fetch item attachments within project scope', async () => {
      const result = await controller.getItemAttachments(
        sampleUserId,
        sampleItemId,
        sampleProjectId,
      );

      expect(mockAttachmentsService.getItemAttachments).toHaveBeenCalledWith(
        sampleUserId,
        sampleItemId,
        sampleProjectId,
      );
      expect(result.attachments).toHaveLength(1);
    });
  });

  describe('ProjectIngestionController', () => {
    let controller: ProjectIngestionController;
    let mockIngestionService: {
      submit: jest.Mock;
    };

    beforeEach(() => {
      mockIngestionService = {
        submit: jest.fn().mockResolvedValue({
          runId: 'run-project-1',
          status: 'ACCEPTED',
        }),
      };

      controller = new ProjectIngestionController(
        mockIngestionService as any,
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

      expect(mockIngestionService.submit).toHaveBeenCalledWith(
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
