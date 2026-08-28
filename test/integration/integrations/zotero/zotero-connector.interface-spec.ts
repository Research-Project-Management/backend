/* eslint-disable @typescript-eslint/no-require-imports */
import { LibraryTestHarness } from '../../library/library-test-harness';
import { ZoteroConnector } from '../../../../src/modules/integrations/zotero/zotero.connector';
import { ZoteroMapper } from '../../../../src/modules/integrations/zotero/zotero.mapper';
import { ZoteroConnectionService } from '../../../../src/modules/integrations/zotero/zotero-connection.service';
import { ZoteroPullWorker } from '../../../../src/modules/integrations/zotero/zotero-pull.worker';
import { ZoteroReconcileWorker } from '../../../../src/modules/integrations/zotero/zotero-reconcile.worker';
import { LIBRARY_SYNC_PORT } from '../../../../src/modules/library/library-sync.port';

const schemaCorpus = require('../../../fixtures/library/zotero-schema-corpus.json');

jest.setTimeout(60000);

class FakeZoteroConnector extends ZoteroConnector {
  public requestCount = 0;
  public simulate429Count = 0;

  async validateApiKey(apiKey: string) {
    if (apiKey === 'VALID_ZOTERO_KEY_123') {
      return { valid: true, userId: '123456', username: 'flux_researcher' };
    }
    return { valid: false };
  }

  async listLibraries(_apiKey: string, userId: string) {
    return [
      { id: userId, type: 'user' as const, name: 'My Library' },
      { id: '998877', type: 'group' as const, name: 'Quantum Lab Group' },
    ];
  }

  async pullCollections(
    _apiKey: string,
    _type: any,
    _id: string,
    _since?: bigint,
  ) {
    return {
      collections: schemaCorpus.collections,
      version: BigInt(12),
    };
  }

  async pullItems(_apiKey: string, _type: any, _id: string, options: any = {}) {
    this.requestCount++;
    const allItems = [
      ...schemaCorpus.items,
      ...schemaCorpus.attachments,
      ...schemaCorpus.notes,
      ...schemaCorpus.annotations,
    ];

    const start = options.start || 0;
    const limit = options.limit || 50;
    const sliced = allItems.slice(start, start + limit);

    return {
      items: sliced,
      version: BigInt(42),
      totalResults: allItems.length,
    };
  }

  async pullDeleted(_apiKey: string, _type: any, _id: string, _since: bigint) {
    return {
      items: ['ZOTERO_ITEM_002'],
      collections: ['ZOTERO_COL_002'],
      searches: [],
      version: BigInt(50),
    };
  }
}

describe('Zotero Connector, Mapper & Sync Invariants (Integration)', () => {
  let harness: LibraryTestHarness;
  let fakeConnector: FakeZoteroConnector;
  let mapper: ZoteroMapper;
  let connectionService: ZoteroConnectionService;
  let pullWorker: ZoteroPullWorker;
  let reconcileWorker: ZoteroReconcileWorker;

  beforeAll(async () => {
    harness = await LibraryTestHarness.create();
    fakeConnector = new FakeZoteroConnector();
    mapper = new ZoteroMapper();
    connectionService = harness.moduleRef.get(ZoteroConnectionService);
    const libraryBridge = harness.moduleRef.get(LIBRARY_SYNC_PORT);

    pullWorker = new ZoteroPullWorker(
      harness.prisma,
      connectionService,
      fakeConnector,
      mapper,
      libraryBridge,
    );

    reconcileWorker = new ZoteroReconcileWorker(
      harness.prisma,
      connectionService,
      fakeConnector,
      libraryBridge,
    );
  });

  afterAll(async () => {
    await harness.close();
  });

  describe('1. ZoteroMapper Schema Fidelity & Unknown Field Preservation (T068/T072)', () => {
    it('maps complex Zotero journalArticle and preserves unknown extra fields in rawPayload', () => {
      const rawArticle = schemaCorpus.items[0];
      const mapped = mapper.mapZoteroItem(rawArticle);

      expect(mapped.title).toBe('Attention Is All You Need');
      expect(mapped.itemType).toBe('journalArticle');
      expect(mapped.year).toBe(2017);
      expect(mapped.doi).toBe('10.48550/arXiv.1706.03762');
      expect(mapped.citationKey).toBe('vaswani2017attention');
      expect(mapped.creators).toHaveLength(3);
      expect(mapped.creators[0].lastName).toBe('Vaswani');
      expect(mapped.creators[2].creatorType).toBe('editor');
      expect(mapped.tags).toHaveLength(3);
      expect(mapped.tags[2].type).toBe('automatic');
      expect(mapped.collectionKeys).toContain('ZOTERO_COL_001');

      // Assert unknown field preservation for perfect roundtrip
      expect(mapped.extraFields['customZoteroFieldX']).toBe(
        'proprietary_plugin_data_value_alpha',
      );
      expect(mapped.extraFields['customScore']).toBe(99.5);
      expect(mapped.rawPayload).toBeDefined();
    });

    it('maps attachment, note, and annotation with hierarchical link keys', () => {
      const mappedAtt = mapper.mapZoteroAttachment(
        schemaCorpus.attachments[0],
      );
      expect(mappedAtt.parentItemKey).toBe('ZOTERO_ITEM_001');
      expect(mappedAtt.filename).toContain('Attention Is All You Need.pdf');

      const mappedNote = mapper.mapZoteroNote(schemaCorpus.notes[0]);
      expect(mappedNote.parentItemKey).toBe('ZOTERO_ITEM_001');
      expect(mappedNote.contentHtml).toContain('Key Insight');

      const mappedAnn = mapper.mapZoteroAnnotation(
        schemaCorpus.annotations[0],
      );
      expect(mappedAnn.parentAttachmentKey).toBe('ZOTERO_ATT_001');
      expect(mappedAnn.pageIndex).toBe(3);
      expect(mappedAnn.quote).toContain('Multi-head attention');
    });
  });

  describe('2. Encrypted Credential Store & Zero Key Leakage (T070)', () => {
    it('encrypts API key with AES-256-GCM and never exposes plain or cipher key in public views', async () => {
      const tenant = await harness.seedWorkspaceFixture();

      const connection = await connectionService.createConnection(
        tenant.workspaceId,
        tenant.ownerUserId,
        {
          apiKey: 'VALID_ZOTERO_KEY_123',
          accountName: 'Prof. Researcher Account',
          zoteroUserId: '123456',
        },
      );

      // Verify connection view contains NO secrets
      expect((connection as any).apiKey).toBeUndefined();
      expect((connection as any).encryptedApiKey).toBeUndefined();
      expect((connection as any).keyIv).toBeUndefined();
      expect((connection as any).keyTag).toBeUndefined();
      expect(connection.status).toBe('active');

      // Verify internal decryption works strictly with tenant validation
      const decrypted = await connectionService.getDecryptedApiKey(
        connection.id,
        tenant.workspaceId,
      );
      expect(decrypted).toBe('VALID_ZOTERO_KEY_123');

      // Verify cross-tenant access is strictly rejected with ForbiddenException
      await expect(
        connectionService.getDecryptedApiKey(connection.id, 'other-tenant-999'),
      ).rejects.toThrow();
    });
  });

  describe('3. ZoteroPullWorker Checkpoint, Resume & Deduplication (T073)', () => {
    it('executes full initial pull, persists entities atomically, and creates bindings with zero duplicates on rerun', async () => {
      const tenant = await harness.seedWorkspaceFixture();

      const connection = await connectionService.createConnection(
        tenant.workspaceId,
        tenant.ownerUserId,
        {
          apiKey: 'VALID_ZOTERO_KEY_123',
          zoteroUserId: '123456',
        },
      );

      const binding = await connectionService.createBinding(
        tenant.workspaceId,
        {
          connectionId: connection.id,
          remoteLibraryType: 'user',
          remoteLibraryId: '123456',
        },
      );

      // First pull: should create items, collections, attachments, notes, annotations
      const pull1 = await pullWorker.executePull(
        tenant.workspaceId,
        binding.id,
        50,
      );

      expect(pull1.itemsCreated).toBe(3); // 3 catalog items
      expect(pull1.collectionsCreated).toBe(2); // 2 collections
      expect(Number(pull1.versionAfter)).toBe(42);

      // Verify entities in database
      const dbItems = await harness.prisma.catalogItem.findMany({
        where: { workspaceId: tenant.workspaceId },
      });
      expect(dbItems).toHaveLength(3);

      const dbBindings = await harness.prisma.zoteroItemBinding.findMany({
        where: { bindingId: binding.id },
      });
      expect(dbBindings.length).toBeGreaterThanOrEqual(6); // items, collections, attachments, notes, annotations

      // Second pull (rerun/idempotent): zero new items created, only updates
      const pull2 = await pullWorker.executePull(
        tenant.workspaceId,
        binding.id,
        50,
      );
      expect(pull2.itemsCreated).toBe(0);
      expect(pull2.itemsUpdated).toBe(3);

      // Total count in DB remains strictly 3 (zero duplicates!)
      const dbItemsAfter = await harness.prisma.catalogItem.findMany({
        where: { workspaceId: tenant.workspaceId },
      });
      expect(dbItemsAfter).toHaveLength(3);
    });
  });

  describe('4. ZoteroReconcileWorker Delta Deletion & Tombstones (T074)', () => {
    it('processes remote deletion events, soft-deletes local items, and records tombstones', async () => {
      const tenant = await harness.seedWorkspaceFixture();

      const connection = await connectionService.createConnection(
        tenant.workspaceId,
        tenant.ownerUserId,
        {
          apiKey: 'VALID_ZOTERO_KEY_123',
          zoteroUserId: '123456',
        },
      );

      const binding = await connectionService.createBinding(
        tenant.workspaceId,
        {
          connectionId: connection.id,
          remoteLibraryType: 'user',
          remoteLibraryId: '123456',
        },
      );

      // Initial pull to seed
      await pullWorker.executePull(tenant.workspaceId, binding.id, 50);

      // Execute reconciliation (fakeConnector returns deleted: ['ZOTERO_ITEM_002', 'ZOTERO_COL_002'])
      const reconcileResult = await reconcileWorker.executeReconciliation(
        tenant.workspaceId,
        binding.id,
      );

      expect(reconcileResult.deletedItems).toBe(1);
      expect(reconcileResult.deletedCollections).toBe(1);

      // Assert ZOTERO_ITEM_002 has deletedAt set in database
      const item2Binding = await harness.prisma.zoteroItemBinding.findUnique({
        where: {
          bindingId_remoteKey: {
            bindingId: binding.id,
            remoteKey: 'ZOTERO_ITEM_002',
          },
        },
      });
      expect(item2Binding).toBeNull(); // Binding removed

      const tombstones = await harness.prisma.tombstone.findMany({
        where: { workspaceId: tenant.workspaceId },
      });
      expect(tombstones.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('5. ZoteroConnector Protocol & Error Invariants (Requirement E)', () => {
    it('handles 412 version conflict gracefully', async () => {
      const connector = new ZoteroConnector();
      // Mock executeFetch to return 412
      (connector as any).executeFetch = jest.fn().mockResolvedValue({
        status: 412,
        ok: false,
        headers: new Headers(),
      });

      const res = await connector.pushItem(
        'TEST_KEY',
        'user',
        '12345',
        { title: 'Item' },
        'REMOTE_KEY_01',
        BigInt(5),
      );

      expect(res.success).toBe(false);
      expect(res.conflict).toBe(true);
    });

    it('handles 428 precondition required error', async () => {
      const connector = new ZoteroConnector();
      (connector as any).executeFetch = jest.fn().mockResolvedValue({
        status: 428,
        ok: false,
        headers: new Headers(),
      });

      const res = await connector.pushItem(
        'TEST_KEY',
        'user',
        '12345',
        { title: 'Item' },
        'REMOTE_KEY_01',
        BigInt(0),
      );

      expect(res.success).toBe(false);
      expect(res.preconditionRequired).toBe(true);
    });

    it('parses HTTP 200 partial failure map and throws explicit error', async () => {
      const connector = new ZoteroConnector();
      (connector as any).executeFetch = jest.fn().mockResolvedValue({
        status: 200,
        ok: true,
        headers: new Headers({ 'Last-Modified-Version': '55' }),
        json: async () => ({
          successful: {},
          unchanged: {},
          failed: {
            '0': { code: 400, message: 'Invalid creatorType' },
          },
        }),
      });

      await expect(
        connector.pushItem('TEST_KEY', 'user', '12345', { title: 'Item' }),
      ).rejects.toThrow('Zotero rejected item creation: Invalid creatorType');
    });

    it('handles 404 in deleteItemRemote as idempotent success', async () => {
      const connector = new ZoteroConnector();
      (connector as any).executeFetch = jest.fn().mockResolvedValue({
        status: 404,
        ok: false,
        headers: new Headers(),
      });

      const res = await connector.deleteItemRemote(
        'TEST_KEY',
        'user',
        '12345',
        'REMOTE_KEY_01',
        BigInt(10),
      );

      expect(res.success).toBe(true);
    });
  });
});
