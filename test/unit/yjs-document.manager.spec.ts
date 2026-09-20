import { YjsDocumentManager } from '@/modules/document/collaboration/yjs-document.manager';
import { PageRepository } from '@/modules/document/page/page.repository';
import * as Y from 'yjs';

describe('YjsDocumentManager (Realtime CRDT Engine)', () => {
  let manager: YjsDocumentManager;
  let mockPageRepo: jest.Mocked<Partial<PageRepository>>;
  let mockPrisma: any;

  const mockPageId = '33333333-3333-3333-3333-333333333333';
  const initialContent =
    '\\documentclass{article}\n\\begin{document}\nHello World\n\\end{document}';

  beforeEach(() => {
    mockPageRepo = {
      findPageById: jest.fn().mockResolvedValue({
        id: mockPageId,
        content: initialContent,
      } as any),
      updatePage: jest.fn().mockResolvedValue({} as any),
    };

    mockPrisma = {
      pageVersion: {
        create: jest.fn().mockResolvedValue({ id: 'v1' }),
      },
    };

    manager = new YjsDocumentManager(
      mockPageRepo as PageRepository,
      mockPrisma,
    );
  });

  afterEach(async () => {
    await manager.onModuleDestroy();
  });

  it('should initialize Y.Doc seeded from PostgreSQL page content', async () => {
    const session = await manager.getOrCreateDoc(mockPageId);

    expect(mockPageRepo.findPageById).toHaveBeenCalledWith(mockPageId);
    expect(session.pageId).toBe(mockPageId);
    expect(manager.getText(mockPageId)).toBe(initialContent);
    expect(session.subscribersCount).toBe(1);
  });

  it('should reuse existing in-memory session when multiple clients connect', async () => {
    const session1 = await manager.getOrCreateDoc(mockPageId);
    const session2 = await manager.getOrCreateDoc(mockPageId);

    expect(mockPageRepo.findPageById).toHaveBeenCalledTimes(1);
    expect(session1).toBe(session2);
    expect(session2.subscribersCount).toBe(2);
  });

  it('should apply binary updates concurrently and maintain consistency', async () => {
    await manager.getOrCreateDoc(mockPageId);

    // Simulate client A creating a doc and typing a citation
    const clientDoc = new Y.Doc();
    const clientText = clientDoc.getText('monaco');

    // Sync client with server
    const serverStateVector = manager.getStateVector(mockPageId)!;
    const serverUpdate = manager.encodeStateAsUpdate(
      mockPageId,
      Y.encodeStateVector(clientDoc),
    )!;
    Y.applyUpdate(clientDoc, serverUpdate);

    // Client A inserts text at the end of "Hello World"
    clientText.insert(
      initialContent.indexOf('Hello World') + 'Hello World'.length,
      ' from Flux!',
    );

    // Client A sends update to manager
    const clientUpdate = Y.encodeStateAsUpdate(clientDoc, serverStateVector);
    manager.applyUpdate(mockPageId, clientUpdate);

    expect(manager.getText(mockPageId)).toContain('Hello World from Flux!');
    clientDoc.destroy();
  });

  it('should flush modified text to database', async () => {
    await manager.getOrCreateDoc(mockPageId);

    // Client modifies document
    const clientDoc = new Y.Doc();
    const clientText = clientDoc.getText('monaco');
    clientText.insert(0, '% New Comment\n');
    const update = Y.encodeStateAsUpdate(clientDoc);
    manager.applyUpdate(mockPageId, update);

    await manager.flushToDatabase(mockPageId);

    expect(mockPageRepo.updatePage).toHaveBeenCalledWith(
      mockPageId,
      expect.objectContaining({
        content: expect.stringContaining('% New Comment\n'),
      }),
    );
    clientDoc.destroy();
  });

  it('should create collaborative checkpoint in version history', async () => {
    await manager.getOrCreateDoc(mockPageId);

    await manager.createCollaborativeCheckpoint(mockPageId, 'user-123');

    expect(mockPrisma.pageVersion.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          pageId: mockPageId,
          savedById: 'user-123',
          eventType: 'collaborative_checkpoint',
        }),
      }),
    );
  });
});
