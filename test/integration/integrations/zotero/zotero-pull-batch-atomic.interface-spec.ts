import { LibraryTestHarness } from '../../library/library-test-harness';
import { ZoteroConnector } from '../../../../src/modules/integrations/zotero/zotero.connector';
import { ZoteroMapper } from '../../../../src/modules/integrations/zotero/zotero.mapper';
import { ZoteroConnectionService } from '../../../../src/modules/integrations/zotero/zotero-connection.service';
import { ZoteroPullWorker } from '../../../../src/modules/integrations/zotero/zotero-pull.worker';
import {
  SYNC_PORT,
  SyncPort,
} from '../../../../src/modules/library/sync/ports/sync.port';
import { ForbiddenException, NotFoundException } from '@nestjs/common';

jest.setTimeout(60000);

class TestFailingZoteroConnector extends ZoteroConnector {
  public shouldFailOnPage = -1;

  async validateApiKey() {
    return { valid: true, userId: 'user-atomic-123', username: 'atomic_user' };
  }

  async listLibraries(_apiKey: string, userId: string) {
    return [{ id: userId, type: 'user' as const, name: 'Atomic Library' }];
  }

  async pullCollections() {
    return {
      collections: [
        {
          key: 'ATOMIC_COL_001',
          version: 10,
          data: {
            key: 'ATOMIC_COL_001',
            version: 10,
            name: 'Atomic Collection 1',
          },
        },
      ],
      version: BigInt(10),
    };
  }

  async pullItems(_apiKey: string, _type: any, _id: string, options: any = {}) {
    const start = options.start || 0;
    const pageIndex = Math.floor(start / 2);

    if (this.shouldFailOnPage === pageIndex) {
      // Simulate corrupted item with invalid structure that fails in Library transaction
      return {
        items: [
          {
            key: 'CORRUPTED_ITEM_PAGE',
            version: 20,
            data: {
              key: 'CORRUPTED_ITEM_PAGE',
              itemType: 'attachment',
              parentItem: 'NON_EXISTENT_PARENT_KEY_99999',
              title: 'Orphan Attachment That Causes Failure',
            },
          },
        ],
        version: BigInt(20),
        totalResults: 4,
      };
    }

    if (pageIndex === 0) {
      return {
        items: [
          {
            key: 'ATOMIC_ITEM_001',
            version: 20,
            data: {
              key: 'ATOMIC_ITEM_001',
              itemType: 'journalArticle',
              title: 'Atomic Item Page 0 - Paper 1',
              creators: [
                {
                  firstName: 'Alan',
                  lastName: 'Turing',
                  creatorType: 'author',
                },
              ],
            },
          },
          {
            key: 'ATOMIC_ATT_001',
            version: 20,
            data: {
              key: 'ATOMIC_ATT_001',
              itemType: 'attachment',
              parentItem: 'ATOMIC_ITEM_001',
              filename: 'turing.pdf',
              url: 'https://test.local/turing.pdf',
              contentType: 'application/pdf',
            },
          },
        ],
        version: BigInt(20),
        totalResults: 4,
      };
    } else {
      return {
        items: [
          {
            key: 'ATOMIC_ITEM_002',
            version: 20,
            data: {
              key: 'ATOMIC_ITEM_002',
              itemType: 'journalArticle',
              title: 'Atomic Item Page 1 - Paper 2',
              creators: [
                {
                  firstName: 'Claude',
                  lastName: 'Shannon',
                  creatorType: 'author',
                },
              ],
            },
          },
        ],
        version: BigInt(20),
        totalResults: 4,
      };
    }
  }
}

describe('ZoteroPullWorker Atomic Batch & Cutover Invariants (Integration)', () => {
  let harness: LibraryTestHarness;
  let fakeConnector: TestFailingZoteroConnector;
  let mapper: ZoteroMapper;
  let connectionService: ZoteroConnectionService;
  let libraryPort: SyncPort;
  let pullWorker: ZoteroPullWorker;

  beforeAll(async () => {
    harness = await LibraryTestHarness.create();
    fakeConnector = new TestFailingZoteroConnector();
    mapper = new ZoteroMapper();
    connectionService = harness.moduleRef.get(ZoteroConnectionService);
    libraryPort = harness.moduleRef.get(SYNC_PORT);

    pullWorker = new ZoteroPullWorker(
      harness.prisma,
      connectionService,
      fakeConnector,
      mapper,
      libraryPort,
    );
  });

  afterAll(async () => {
    await harness.close();
  });

  it('1. ZoteroPullWorker uses applyExternalSyncBatch and creates parent item + attachment in same atomic batch', async () => {
    const tenant = await harness.seedWorkspaceFixture();

    const connection = await connectionService.createConnection(
      tenant.workspaceId,
      tenant.ownerUserId,
      {
        apiKey: 'VALID_ZOTERO_KEY_ATOMIC',
        zoteroUserId: 'user-atomic-123',
      },
    );

    const binding = await connectionService.createBinding(tenant.workspaceId, {
      connectionId: connection.id,
      remoteLibraryType: 'user',
      remoteLibraryId: 'user-atomic-123',
    });

    const spy = jest.spyOn(libraryPort, 'applyExternalSyncBatch');

    const result = await pullWorker.executePull(
      tenant.workspaceId,
      binding.id,
      2,
    );

    expect(spy).toHaveBeenCalled();
    expect(result.itemsCreated).toBe(2);
    expect(result.collectionsCreated).toBe(1);
    expect(Number(result.versionAfter)).toBe(20);

    // Verify parent item created
    const item1 = await harness.prisma.catalogItem.findFirst({
      where: {
        workspaceId: tenant.workspaceId,
        title: 'Atomic Item Page 0 - Paper 1',
      },
      include: { attachments: { include: { revisions: true } } },
    });
    expect(item1).not.toBeNull();
    expect(item1?.attachments).toHaveLength(1);
    expect(item1?.attachments[0].filename).toBe('turing.pdf');
    expect(item1?.attachments[0].revisions).toHaveLength(1);

    // Verify bindings created for both item and attachment
    const itemBinding = await harness.prisma.zoteroItemBinding.findUnique({
      where: {
        bindingId_remoteKey: {
          bindingId: binding.id,
          remoteKey: 'ATOMIC_ITEM_001',
        },
      },
    });
    expect(itemBinding).not.toBeNull();
    expect(itemBinding?.entityId).toBe(item1?.id);

    const attBinding = await harness.prisma.zoteroItemBinding.findUnique({
      where: {
        bindingId_remoteKey: {
          bindingId: binding.id,
          remoteKey: 'ATOMIC_ATT_001',
        },
      },
    });
    expect(attBinding).not.toBeNull();
    expect(attBinding?.entityId).toBe(item1?.attachments[0].id);

    spy.mockRestore();
  });

  it('2. Failure in a page rolls back the entire page and checkpoint does NOT advance', async () => {
    const tenant = await harness.seedWorkspaceFixture();

    const connection = await connectionService.createConnection(
      tenant.workspaceId,
      tenant.ownerUserId,
      {
        apiKey: 'VALID_ZOTERO_KEY_ATOMIC',
        zoteroUserId: 'user-atomic-123',
      },
    );

    const binding = await connectionService.createBinding(tenant.workspaceId, {
      connectionId: connection.id,
      remoteLibraryType: 'user',
      remoteLibraryId: 'user-atomic-123',
    });

    // Make page 0 fail
    fakeConnector.shouldFailOnPage = 0;

    await expect(
      pullWorker.executePull(tenant.workspaceId, binding.id, 2),
    ).rejects.toThrow();

    // Verify checkpoint did NOT advance
    const bindingAfterFail = await harness.prisma.zoteroBinding.findUnique({
      where: { id: binding.id },
    });
    expect(bindingAfterFail?.lastSyncVersion).toBe(BigInt(0));

    // Verify syncRun marked failed
    const syncRun = await harness.prisma.zoteroSyncRun.findFirst({
      where: { bindingId: binding.id },
      orderBy: { startedAt: 'desc' },
    });
    expect(syncRun?.status).toBe('failed');

    // Verify failure logged
    const failure = await harness.prisma.zoteroSyncFailure.findFirst({
      where: { bindingId: binding.id },
    });
    expect(failure).not.toBeNull();

    // Reset failure
    fakeConnector.shouldFailOnPage = -1;
  });

  it('3. Crash recovery & Idempotency: retry after simulated crash returns cached local entity IDs without duplicate writes', async () => {
    const tenant = await harness.seedWorkspaceFixture();

    const idempotencyKey = `test:crash:recovery:${Date.now()}`;
    const operations: any = [
      {
        operationId: 'item:CRASH_TEST_01',
        op: 'upsertCatalogItem',
        command: {
          workspaceId: tenant.workspaceId,
          userId: tenant.ownerUserId,
          title: 'Crash Recovery Test Paper',
        },
      },
    ];

    // First call (successful Library commit)
    const batchRes1 = await libraryPort.applyExternalSyncBatch({
      workspaceId: tenant.workspaceId,
      idempotencyKey,
      operations,
    });

    expect(batchRes1.results).toHaveLength(1);
    const createdId = batchRes1.results[0].result?.id;
    expect(createdId).toBeDefined();

    // Verify entity in DB
    const countBefore = await harness.prisma.catalogItem.count({
      where: {
        workspaceId: tenant.workspaceId,
        title: 'Crash Recovery Test Paper',
      },
    });
    expect(countBefore).toBe(1);

    // Simulate crash and retry with exact same idempotencyKey and payload
    const batchRes2 = await libraryPort.applyExternalSyncBatch({
      workspaceId: tenant.workspaceId,
      idempotencyKey,
      operations,
    });

    expect(batchRes2.results).toHaveLength(1);
    expect(batchRes2.results[0].result?.id).toBe(createdId);

    // Assert zero duplicates created
    const countAfter = await harness.prisma.catalogItem.count({
      where: {
        workspaceId: tenant.workspaceId,
        title: 'Crash Recovery Test Paper',
      },
    });
    expect(countAfter).toBe(1);
  });

  it('4. Cross-workspace reference in batch is strictly rejected with ForbiddenException', async () => {
    const tenantA = await harness.seedWorkspaceFixture();
    const tenantB = await harness.seedWorkspaceFixture();

    await expect(
      libraryPort.applyExternalSyncBatch({
        workspaceId: tenantA.workspaceId,
        operations: [
          {
            operationId: 'item:WS_A_ITEM',
            op: 'upsertCatalogItem',
            command: {
              workspaceId: tenantB.workspaceId, // Mismatched workspace
              userId: tenantB.ownerUserId,
              title: 'Cross Workspace Item',
            },
          },
        ],
      }),
    ).rejects.toThrow(ForbiddenException);
  });
});
