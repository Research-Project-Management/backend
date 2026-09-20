import {
  INTEGRATION_EVENT_TOPICS,
  createIntegrationEvent,
} from '../../src/modules/library/shared-kernel/events/integration-events';
import { IntegrationEventBusService } from '../../src/modules/library/shared-kernel/events/integration-event-bus.service';
import { CatalogEventsSubscriber } from '../../src/modules/library/discovery/infrastructure/subscribers/catalog-events.subscriber';
import { ItemLifecycleSubscriber } from '../../src/modules/library/content/infrastructure/subscribers/item-lifecycle.subscriber';
import { TransactionService } from '../../src/modules/library/shared-kernel/outbox/transaction.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { SearchService } from '../../src/modules/library/discovery/application/services/search.service';
import { PrismaService } from '../../src/core/database/prisma.service';

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
      mockSearchService = {
        indexPaperForRag: jest.fn().mockResolvedValue({ success: true }),
      } as any;

      subscriber = new CatalogEventsSubscriber(mockSearchService);
    });

    it('should trigger search indexing on CATALOG_ITEM_CREATED event', async () => {
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

      await subscriber.handleItemCreated(event);

      expect(mockSearchService.indexPaperForRag).toHaveBeenCalledTimes(1);
      expect(mockSearchService.indexPaperForRag).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'item-xyz',
          userId: 'user-1',
          title: 'Quantum Advantage',
        }),
      );
    });

    it('should gracefully handle indexing errors without throwing', async () => {
      mockSearchService.indexPaperForRag.mockRejectedValueOnce(
        new Error('Search engine unavailable'),
      );

      const event = createIntegrationEvent(
        INTEGRATION_EVENT_TOPICS.CATALOG_ITEM_CREATED,
        'catalog',
        { itemId: 'item-err', title: 'Error Paper', itemType: 'book' },
        { userId: 'user-1' },
      );

      // Should not throw
      await expect(
        subscriber.handleItemCreated(event as any),
      ).resolves.not.toThrow();
    });
  });

  describe('Content Bounded Context - ItemLifecycleSubscriber', () => {
    let mockPrisma: any;
    let subscriber: ItemLifecycleSubscriber;

    beforeEach(() => {
      mockPrisma = {
        attachment: {
          updateMany: jest.fn().mockResolvedValue({ count: 2 }),
        },
      };

      subscriber = new ItemLifecycleSubscriber(mockPrisma as PrismaService);
    });

    it('should soft-delete associated attachments on CATALOG_ITEM_DELETED event', async () => {
      const event = createIntegrationEvent(
        INTEGRATION_EVENT_TOPICS.CATALOG_ITEM_DELETED,
        'catalog',
        { itemId: 'item-del-1', version: 2 },
        { userId: 'user-1' },
      );

      await subscriber.handleItemDeleted(event);

      expect(mockPrisma.attachment.updateMany).toHaveBeenCalledWith({
        where: { itemId: 'item-del-1', deletedAt: null },
        data: { deletedAt: expect.any(Date) },
      });
    });
  });
});
