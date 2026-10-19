import { ItemsController } from '@/modules/library/catalog/controllers/items.controller';
import { CollectionsController } from '@/modules/library/catalog/controllers/collections.controller';
import {
  StateController,
  StateBatchController,
} from '@/modules/library/catalog/controllers/state.controller';
import { AttachmentController } from '@/modules/library/extraction/controllers/attachments.controller';
import { IngestionController } from '@/modules/library/ingestion/controllers/ingestion.controller';

describe('Project-Scoped Library Controllers (Strict UUID & Project Isolation)', () => {
  const sampleProjectId = '11111111-2222-4333-8444-555555555555';
  const sampleUserId = 'user-test-1';
  const sampleItemId = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';

  describe('ItemsController (Project Scope)', () => {
    let controller: ItemsController;
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

      controller = new ItemsController(
        mockItemService as any,
        mockItemService as any,
        mockItemService as any,
      );
    });

    it('should pass projectId strictly to listItems', async () => {
      const result = await controller.listItems(
        sampleUserId,
        { view: 'all' },
        sampleProjectId,
      );

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

  describe('CollectionsController (Project Scope)', () => {
    let controller: CollectionsController;
    let mockCollectionsService: {
      getCollections: jest.Mock;
    };

    beforeEach(() => {
      mockCollectionsService = {
        getCollections: jest
          .fn()
          .mockResolvedValue([{ id: 'col-1', name: 'Project Collection' }]),
      };

      controller = new CollectionsController(
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

  describe('StateController & StateBatchController (Project Scope)', () => {
    let stateController: StateController;
    let batchController: StateBatchController;
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

      stateController = new StateController(mockStateService as any);
      batchController = new StateBatchController(
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

  describe('AttachmentController', () => {
    let controller: AttachmentController;
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

      controller = new AttachmentController(
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

  describe('IngestionController', () => {
    let controller: IngestionController;
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

      controller = new IngestionController(
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
