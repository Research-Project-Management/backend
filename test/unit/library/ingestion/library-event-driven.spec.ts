import { SearchEventsSubscriber } from '@/modules/library/search/subscribers/search-events.subscriber';
import { ItemLifecycleSubscriber } from '@/modules/library/extraction/subscribers/item-lifecycle.subscriber';
import { AttachmentsRepository } from '@/modules/library/extraction/repositories/attachments.repository';
import { AnnotationsRepository } from '@/modules/library/extraction/repositories/annotations.repository';
import { SearchService } from '@/modules/library/search/services/search.service';

describe('Library Module - Event-Driven Architecture (Cross-BC Integration)', () => {
  describe('Discovery Bounded Context - SearchEventsSubscriber', () => {
    let mockSearchService: jest.Mocked<SearchService>;
    let subscriber: SearchEventsSubscriber;

    beforeEach(() => {
      mockSearchService = {} as any;
      subscriber = new SearchEventsSubscriber(mockSearchService);
    });

    it('should handle ITEM_CREATED event without throwing', async () => {
      await expect(
        subscriber.handleItemChanged({
          eventType: 'library.item.created',
          aggregateId: 'item-xyz',
          userId: 'user-1',
        } as any),
      ).resolves.not.toThrow();
    });

    it('should ignore event when payload has no itemId', async () => {
      await expect(subscriber.handleItemChanged({} as any)).resolves.not.toThrow();
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

    it('should soft-delete associated attachments and annotations on ITEM_DELETED event', async () => {
      await subscriber.handleItemDeleted({
        aggregateId: 'item-del-1',
      });

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
