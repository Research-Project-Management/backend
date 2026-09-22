import {
  INTEGRATION_EVENT_TOPICS,
  createIntegrationEvent,
} from '../../src/modules/library/shared-kernel/events/integration-events';
import { IntegrationEventBusService } from '../../src/modules/library/shared-kernel/events/integration-event-bus.service';
import { CatalogEventsSubscriber } from '../../src/modules/library/search/infrastructure/subscribers/catalog-events.subscriber';
import { ItemLifecycleSubscriber } from '../../src/modules/library/reader/infrastructure/subscribers/item-lifecycle.subscriber';
import { TransactionService } from '../../src/modules/library/shared-kernel/outbox/transaction.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { SearchService } from '../../src/modules/library/search/application/services/search.service';
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

  describe('Content Bounded Context - ItemLifecycleSubscriber', () => {
    let mockPrisma: any;
    let subscriber: ItemLifecycleSubscriber;

    beforeEach(() => {
      mockPrisma = {
        attachment: {
          findMany: jest
            .fn()
            .mockResolvedValue([{ id: 'att-1' }, { id: 'att-2' }]),
          updateMany: jest.fn().mockResolvedValue({ count: 2 }),
        },
        annotation: {
          updateMany: jest.fn().mockResolvedValue({ count: 5 }),
        },
        note: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      };

      subscriber = new ItemLifecycleSubscriber(mockPrisma as PrismaService);
    });

    it('should soft-delete associated attachments, notes, and annotations on CATALOG_ITEM_DELETED event', async () => {
      const event = createIntegrationEvent(
        INTEGRATION_EVENT_TOPICS.CATALOG_ITEM_DELETED,
        'catalog',
        { itemId: 'item-del-1', version: 2 },
        { userId: 'user-1' },
      );

      await subscriber.handleItemDeleted(event);

      expect(mockPrisma.attachment.findMany).toHaveBeenCalledWith({
        where: { itemId: 'item-del-1' },
        select: { id: true },
      });
      expect(mockPrisma.annotation.updateMany).toHaveBeenCalledWith({
        where: { attachmentId: { in: ['att-1', 'att-2'] }, deletedAt: null },
        data: { deletedAt: expect.any(Date) },
      });
      expect(mockPrisma.attachment.updateMany).toHaveBeenCalledWith({
        where: { itemId: 'item-del-1', deletedAt: null },
        data: { deletedAt: expect.any(Date) },
      });
      expect(mockPrisma.note.updateMany).toHaveBeenCalledWith({
        where: { itemId: 'item-del-1', deletedAt: null },
        data: { deletedAt: expect.any(Date) },
      });
    });
  });
});
