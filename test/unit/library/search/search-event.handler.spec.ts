import { SearchEventHandler } from '../../../../src/modules/library/search/handlers/search-event.handler';
import { SYNC_EVENT_TYPES } from '../../../../src/modules/library/sync/events/library.events';

describe('SearchEventHandler (Unit)', () => {
  let handler: SearchEventHandler;
  let mockIndexer: any;
  let mockPrisma: any;

  beforeEach(() => {
    mockIndexer = {
      indexAttachmentPages: jest.fn(),
    };
    mockPrisma = {
      catalogAttachment: {
        findMany: jest.fn(),
      },
      fullTextIndex: {
        deleteMany: jest.fn(),
      },
    };
    handler = new SearchEventHandler(mockIndexer, mockPrisma);
  });

  it('cleans up full-text indexes when an item is deleted', async () => {
    mockPrisma.catalogAttachment.findMany.mockResolvedValue([
      { id: 'att-1' },
      { id: 'att-2' },
    ]);
    mockPrisma.fullTextIndex.deleteMany.mockResolvedValue({ count: 5 });

    await handler.handleItemDeleted({
      eventId: 'evt-1',
      workspaceId: 'ws-123',
      aggregateId: 'item-999',
      eventType: SYNC_EVENT_TYPES.ITEM_DELETED,
      payload: { id: 'item-999' },
      createdAt: new Date(),
    });

    expect(mockPrisma.catalogAttachment.findMany).toHaveBeenCalledWith({
      where: { catalogItemId: 'item-999' },
      select: { id: true },
    });
    expect(mockPrisma.fullTextIndex.deleteMany).toHaveBeenCalledTimes(2);
    expect(mockPrisma.fullTextIndex.deleteMany).toHaveBeenCalledWith({
      where: { attachmentId: 'att-1' },
    });
  });

  it('cleans up full-text index when an attachment is deleted', async () => {
    mockPrisma.fullTextIndex.deleteMany.mockResolvedValue({ count: 3 });

    await handler.handleAttachmentDeleted({
      eventId: 'evt-2',
      workspaceId: 'ws-123',
      aggregateId: 'att-456',
      eventType: SYNC_EVENT_TYPES.ATTACHMENT_DELETED,
      payload: { id: 'att-456' },
      createdAt: new Date(),
    });

    expect(mockPrisma.fullTextIndex.deleteMany).toHaveBeenCalledWith({
      where: { attachmentId: 'att-456' },
    });
  });
});
