import { ZoteroStreamOutboxHandler } from '../../../../src/modules/integrations/zotero/zotero-stream.handler';
import { IntegrationOutboxEvent } from '../../../../src/modules/library/sync/library-sync.port';

describe('ZoteroStreamOutboxHandler', () => {
  let handler: ZoteroStreamOutboxHandler;
  let mockPrisma: any;
  let mockPullWorker: any;
  let mockReconcileWorker: any;

  beforeEach(() => {
    mockPrisma = {
      zoteroBinding: {
        findUnique: jest.fn(),
      },
    };
    mockPullWorker = {
      executePull: jest
        .fn()
        .mockResolvedValue({ itemsPulled: 5, newVersion: BigInt(42) }),
    };
    mockReconcileWorker = {
      executeReconciliation: jest
        .fn()
        .mockResolvedValue({ status: 'completed' }),
    };

    handler = new ZoteroStreamOutboxHandler(
      mockPrisma,
      mockPullWorker,
      mockReconcileWorker,
    );
  });

  it('triggers executePull when stream notification is updated or catchUp', async () => {
    mockPrisma.zoteroBinding.findUnique.mockResolvedValue({
      id: 'bind-1',
      workspaceId: 'ws-1',
      connection: { status: 'active' },
    });

    const event: IntegrationOutboxEvent = {
      id: 'evt-1',
      workspaceId: 'ws-1',
      aggregateId: 'bind-1',
      eventType: 'library.zotero.stream_event_received',
      payload: {
        bindingId: 'bind-1',
        topic: '/users/12345',
        event: 'updated',
        version: 42,
      },
      dedupeKey: 'zotero_stream_bind-1_/users/12345_updated_42',
      createdAt: new Date(),
    };

    await handler.handle(event);

    expect(mockPullWorker.executePull).toHaveBeenCalledWith('ws-1', 'bind-1');
    expect(mockReconcileWorker.executeReconciliation).not.toHaveBeenCalled();
  });

  it('triggers executeReconciliation when stream notification is deleted', async () => {
    mockPrisma.zoteroBinding.findUnique.mockResolvedValue({
      id: 'bind-1',
      workspaceId: 'ws-1',
      connection: { status: 'active' },
    });

    const event: IntegrationOutboxEvent = {
      id: 'evt-2',
      workspaceId: 'ws-1',
      aggregateId: 'bind-1',
      eventType: 'library.zotero.stream_event_received',
      payload: {
        bindingId: 'bind-1',
        topic: '/users/12345',
        event: 'deleted',
      },
      dedupeKey: 'zotero_stream_bind-1_/users/12345_deleted_0',
      createdAt: new Date(),
    };

    await handler.handle(event);

    expect(mockReconcileWorker.executeReconciliation).toHaveBeenCalledWith(
      'ws-1',
      'bind-1',
    );
    expect(mockPullWorker.executePull).not.toHaveBeenCalled();
  });

  it('safely skips execution if connection is inactive', async () => {
    mockPrisma.zoteroBinding.findUnique.mockResolvedValue({
      id: 'bind-1',
      workspaceId: 'ws-1',
      connection: { status: 'revoked' },
    });

    const event: IntegrationOutboxEvent = {
      id: 'evt-3',
      workspaceId: 'ws-1',
      aggregateId: 'bind-1',
      eventType: 'library.zotero.stream_event_received',
      payload: {
        bindingId: 'bind-1',
        event: 'updated',
      },
      dedupeKey: 'zotero_stream_bind-1_any_updated_0',
      createdAt: new Date(),
    };

    await handler.handle(event);

    expect(mockPullWorker.executePull).not.toHaveBeenCalled();
  });
});
