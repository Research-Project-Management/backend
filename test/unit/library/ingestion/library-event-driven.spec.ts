import {
  INTEGRATION_EVENT_TOPICS,
  createIntegrationEvent,
} from '@/modules/library/shared-kernel/events/integration-events';
import {
  IntegrationEventBusService,
  TransactionService,
} from '@/modules/library/sync';
import { SearchEventsSubscriber as CatalogEventsSubscriber } from '@/modules/library/search/services/search-events.subscriber';
import { ItemLifecycleSubscriber } from '@/modules/library/extraction/utils/item-lifecycle.subscriber';
import { AttachmentsRepository } from '@/modules/library/extraction/repositories/attachments.repository';
import { AnnotationsRepository } from '@/modules/library/extraction/repositories/annotations.repository';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { SearchService } from '@/modules/library/search/services/search.service';

describe('Library Module - Event-Driven Architecture (Cross-BC Integration)', () => {
  describe('Integration Events Factory', () => {
    it('createIntegrationEvent should produce a valid typed envelope with timestamp and UUID', () => {
      const event = createIntegrationEvent(
        INTEGRATION_EVENT_TOPICS.CATALOG_ITEM_CREATED,
        'catalog',
        {
          itemId: 'item-100',
          title: 'Event Driven Microservices',
          itemType: 'book',
        },
        { userId: 'user-42', projectId: 'proj-1' },
      );

      expect(event.eventId).toBeDefined();
      expect(event.topic).toBe(INTEGRATION_EVENT_TOPICS.CATALOG_ITEM_CREATED);
      expect(event.sourceContext).toBe('catalog');
      expect(event.payload.itemId).toBe('item-100');
      expect(event.scope.userId).toBe('user-42');
      expect(new Date(event.occurredAt).getTime()).not.toBeNaN();
    });
  });

  describe('IntegrationEventBusService', () => {
    let mockTxService: jest.Mocked<TransactionService>;
    let mockEventEmitter: jest.Mocked<EventEmitter2>;
    let eventBus: IntegrationEventBusService;

    beforeEach(() => {
      mockTxService = {
        executeInTransaction: jest.fn().mockImplementation(async (op: any) => {
          const helpers = {
            publishOutbox: jest.fn().mockResolvedValue({ id: 'outbox-1' }),
          };
          return op(null, helpers);
        }),
      } as any;

      mockEventEmitter = {
        emit: jest.fn(),
      } as any;

      eventBus = new IntegrationEventBusService(
        mockTxService,
        mockEventEmitter,
      );
    });

    it('should persist integration event to outbox and emit locally on EventEmitter2', async () => {
      const event = createIntegrationEvent(
        INTEGRATION_EVENT_TOPICS.CATALOG_ITEM_CREATED,
        'catalog',
        { itemId: 'item-abc', title: 'Test Paper', itemType: 'journalArticle' },
        { userId: 'user-1' },
      );

      await eventBus.publish(event);

      expect(mockTxService.executeInTransaction).toHaveBeenCalledTimes(1);
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        INTEGRATION_EVENT_TOPICS.CATALOG_ITEM_CREATED,
        event,
      );
    });
  });

  describe('Discovery Bounded Context - CatalogEventsSubscriber', () => {
    let mockSearchService: jest.Mocked<SearchService>;
    let subscriber: CatalogEventsSubscriber;

    beforeEach(() => {
      mockSearchService = {} as any;
      subscriber = new CatalogEventsSubscriber(mockSearchService);
    });

    it('should handle CATALOG_ITEM_CREATED event without throwing', async () => {
      const event = createIntegrationEvent(
        INTEGRATION_EVENT_TOPICS.CATALOG_ITEM_CREATED,
        'catalog',
        {
          itemId: 'item-xyz',
          title: 'Quantum Advantage',
          itemType: 'journalArticle',
          abstract: 'A paper on quantum computing',
          doi: '10.1038/s41586-019-1666-5',
        },
        { userId: 'user-1' },
      );

      await expect(subscriber.handleItemCreated(event)).resolves.not.toThrow();
    });

    it('should ignore event when payload has no itemId', async () => {
      const event = createIntegrationEvent(
        INTEGRATION_EVENT_TOPICS.CATALOG_ITEM_CREATED,
        'catalog',
        {} as any,
        { userId: 'user-1' },
      );

      await expect(subscriber.handleItemCreated(event)).resolves.not.toThrow();
    });
  });

  describe('Extraction Bounded Context - ItemLifecycleSubscriber', () => {
    let mockAttachmentsRepo: Partial<jest.Mocked<AttachmentsRepository>>;
    let mockAnnotationsRepo: Partial<jest.Mocked<AnnotationsRepository>>;
    let subscriber: ItemLifecycleSubscriber;

    beforeEach(() => {
      mockAttachmentsRepo = {
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: 'att-1' }, { id: 'att-2' }]),
        softDeleteByItemId: jest.fn().mockResolvedValue(2),
        deleteManyByItemId: jest.fn().mockResolvedValue(2),
      };
      mockAnnotationsRepo = {
        softDeleteByAttachmentIds: jest.fn().mockResolvedValue(5),
        deleteManyByItemId: jest.fn().mockResolvedValue(5),
      };

      subscriber = new ItemLifecycleSubscriber(
        mockAttachmentsRepo as unknown as AttachmentsRepository,
        mockAnnotationsRepo as unknown as AnnotationsRepository,
      );
    });

    it('should soft-delete associated attachments and annotations on CATALOG_ITEM_DELETED event', async () => {
      const event = createIntegrationEvent(
        INTEGRATION_EVENT_TOPICS.CATALOG_ITEM_DELETED,
        'catalog',
        { itemId: 'item-del-1', version: 2 },
        { userId: 'user-1' },
      );

      await subscriber.handleItemDeleted(event);

      expect(mockAttachmentsRepo.findMany).toHaveBeenCalledWith({
        itemId: 'item-del-1',
        deletedAt: null,
      });
      expect(
        mockAnnotationsRepo.softDeleteByAttachmentIds,
      ).toHaveBeenCalledWith(['att-1', 'att-2']);
      expect(mockAttachmentsRepo.softDeleteByItemId).toHaveBeenCalledWith(
        'item-del-1',
      );
    });

    it('should purge associated attachments and annotations on library.item.purged event', async () => {
      await subscriber.handleItemPurged({ id: 'item-del-1' });

      expect(mockAnnotationsRepo.deleteManyByItemId).toHaveBeenCalledWith(
        'item-del-1',
      );
      expect(mockAttachmentsRepo.deleteManyByItemId).toHaveBeenCalledWith(
        'item-del-1',
      );
    });
  });
});
