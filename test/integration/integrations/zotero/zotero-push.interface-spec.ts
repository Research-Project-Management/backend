import { LibraryTestHarness } from '../../library/library-test-harness';
import { ZoteroPushWorker } from '../../../../src/modules/integrations/zotero/zotero-push.worker';
import { ZoteroConnector } from '../../../../src/modules/integrations/zotero/zotero.connector';
import { ZoteroConnectionService } from '../../../../src/modules/integrations/zotero/zotero-connection.service';
import { ZoteroMapper } from '../../../../src/modules/integrations/zotero/zotero.mapper';
import { ZoteroConflictService } from '../../../../src/modules/integrations/zotero/zotero-conflict.service';
import { ZoteroSyncPolicy } from '../../../../src/modules/integrations/zotero/zotero-sync.policy';
import { LIBRARY_SYNC_PORT } from '../../../../src/modules/library/library-sync.port';

jest.setTimeout(60000);

class PushMockZoteroConnector extends ZoteroConnector {
  public pushAttempts = 0;
  public simulateConflictOnKey = '';
  public remoteStateMap = new Map<string, any>();

  async validateApiKey(apiKey: string) {
    if (apiKey === 'VALID_PUSH_KEY_999') {
      return { valid: true, userId: '999111', username: 'push_researcher' };
    }
    return { valid: false };
  }

  async pullItems(
    _apiKey: string,
    _type: any,
    _id: string,
    _options: any = {},
  ): Promise<any> {
    const items = Array.from(this.remoteStateMap.values());
    return {
      items,
      version: BigInt(50),
      totalResults: items.length,
    };
  }

  async pushItem(
    _apiKey: string,
    _libraryType: any,
    _libraryId: string,
    itemPayload: Record<string, any>,
    remoteKey?: string,
    remoteVersion?: bigint,
  ): Promise<any> {
    this.pushAttempts++;

    if (remoteKey && remoteKey === this.simulateConflictOnKey) {
      this.simulateConflictOnKey = ''; // Clear conflict for retry
      return {
        success: false,
        key: remoteKey,
        version: remoteVersion || BigInt(10),
        conflict: true,
      };
    }

    const key = remoteKey || `REMOTE_KEY_${Date.now()}`;
    const version = (remoteVersion || BigInt(10)) + BigInt(1);

    this.remoteStateMap.set(key, {
      key,
      version: Number(version),
      data: {
        key,
        version: Number(version),
        ...itemPayload,
      },
    });

    return {
      success: true,
      key,
      version,
    };
  }

  async deleteItemRemote(
    _apiKey: string,
    _libraryType: any,
    _libraryId: string,
    remoteKey: string,
    _remoteVersion?: bigint,
  ): Promise<any> {
    this.remoteStateMap.delete(remoteKey);
    return { success: true };
  }
}

describe('Zotero Two-Way Push & Three-Way Conflict Resolution (Integration T079/T080/T081)', () => {
  let harness: LibraryTestHarness;
  let mockConnector: PushMockZoteroConnector;
  let pushWorker: ZoteroPushWorker;
  let connectionService: ZoteroConnectionService;
  let syncPolicy: ZoteroSyncPolicy;
  let conflictService: ZoteroConflictService;

  beforeAll(async () => {
    harness = await LibraryTestHarness.create();
    mockConnector = new PushMockZoteroConnector();
    connectionService = harness.moduleRef.get(ZoteroConnectionService);
    syncPolicy = harness.moduleRef.get(ZoteroSyncPolicy);
    conflictService = harness.moduleRef.get(ZoteroConflictService);
    const mapper = harness.moduleRef.get(ZoteroMapper);
    const libraryBridge = harness.moduleRef.get(LIBRARY_SYNC_PORT);

    pushWorker = new ZoteroPushWorker(
      harness.prisma,
      connectionService,
      mockConnector,
      mapper,
      conflictService,
      syncPolicy,
      libraryBridge,
    );
  });

  afterAll(async () => {
    await harness.close();
  });

  it('1. Clean Two-Way Push: pushes local catalog item and records remote binding + outbox', async () => {
    const tenant = await harness.seedWorkspaceFixture();

    // Enable two-way push for test tenant
    syncPolicy.setWorkspaceOverride(tenant.workspaceId, {
      zoteroTwoWaySync: true,
    });

    const connection = await connectionService.createConnection(
      tenant.workspaceId,
      tenant.ownerUserId,
      {
        apiKey: 'VALID_PUSH_KEY_999',
        zoteroUserId: '999111',
      },
    );

    const binding = await harness.prisma.zoteroBinding.create({
      data: {
        connectionId: connection.id,
        workspaceId: tenant.workspaceId,
        remoteLibraryType: 'user',
        remoteLibraryId: '999111',
        syncDirection: 'two_way',
      },
    });

    const item = await harness.prisma.catalogItem.create({
      data: {
        workspaceId: tenant.workspaceId,
        title: 'Advances in Transformer Quantization',
        abstract: '8-bit and 4-bit weight quantization strategies.',
        year: 2024,
        doi: '10.1145/quant2024',
        uploadedById: tenant.ownerUserId,
        filename: 'quant2024.pdf',
        fileUrl: 'https://test.local/quant2024.pdf',
      },
    });

    // Execute Push
    const result = await pushWorker.pushItem(
      tenant.workspaceId,
      binding.id,
      item.id,
    );

    expect(result.success).toBe(true);
    expect(result.status).toBe('synced');
    expect(result.remoteKey).toBeDefined();

    // Verify ZoteroItemBinding in database
    const itemBinding = await harness.prisma.zoteroItemBinding.findUnique({
      where: {
        bindingId_remoteKey: {
          bindingId: binding.id,
          remoteKey: result.remoteKey!,
        },
      },
    });

    expect(itemBinding).not.toBeNull();
    expect(itemBinding?.syncState).toBe('synced');
    expect(itemBinding?.entityId).toBe(item.id);

    // Verify Outbox event was published
    const outbox = await harness.prisma.outboxEvent.findFirst({
      where: {
        workspaceId: tenant.workspaceId,
        eventType: 'library.zotero.item_pushed',
      },
    });
    expect(outbox).not.toBeNull();
  });

  it('2. Three-Way Auto-Merge: automatically merges non-conflicting remote and local edits', async () => {
    const tenant = await harness.seedWorkspaceFixture();
    syncPolicy.setWorkspaceOverride(tenant.workspaceId, {
      zoteroTwoWaySync: true,
    });

    const connection = await connectionService.createConnection(
      tenant.workspaceId,
      tenant.ownerUserId,
      {
        apiKey: 'VALID_PUSH_KEY_999',
        zoteroUserId: '999111',
      },
    );

    const binding = await harness.prisma.zoteroBinding.create({
      data: {
        connectionId: connection.id,
        workspaceId: tenant.workspaceId,
        remoteLibraryType: 'user',
        remoteLibraryId: '999111',
        syncDirection: 'two_way',
      },
    });

    const initialItem = await harness.prisma.catalogItem.create({
      data: {
        workspaceId: tenant.workspaceId,
        title: 'Original Title',
        abstract: 'Original Abstract',
        uploadedById: tenant.ownerUserId,
        filename: 'original.pdf',
        fileUrl: 'https://test.local/original.pdf',
      },
    });

    const remoteKey = 'ZOTERO_CONFLICT_TEST_01';
    await harness.prisma.zoteroItemBinding.create({
      data: {
        bindingId: binding.id,
        workspaceId: tenant.workspaceId,
        entityType: 'item',
        entityId: initialItem.id,
        remoteKey,
        remoteVersion: BigInt(10),
        baseSnapshot: {
          title: 'Original Title',
          abstractNote: 'Original Abstract',
        },
        syncState: 'synced',
      },
    });

    // Local changes title
    await harness.prisma.catalogItem.update({
      where: { id: initialItem.id },
      data: { title: 'Updated Local Title By Flux' },
    });

    // Remote changed abstract Note
    mockConnector.remoteStateMap.set(remoteKey, {
      key: remoteKey,
      version: 12,
      data: {
        key: remoteKey,
        version: 12,
        title: 'Original Title',
        abstractNote: 'Updated Remote Abstract By Zotero',
      },
    });

    // Simulate 412 conflict on first push to trigger 3-way merge
    mockConnector.simulateConflictOnKey = remoteKey;

    const result = await pushWorker.pushItem(
      tenant.workspaceId,
      binding.id,
      initialItem.id,
    );

    expect(result.success).toBe(true);
    expect(result.status).toBe('synced');

    // Verify local item contains merged abstract
    const updatedLocal = await harness.prisma.catalogItem.findUnique({
      where: { id: initialItem.id },
    });
    expect(updatedLocal?.title).toBe('Updated Local Title By Flux');
    expect(updatedLocal?.abstract).toBe('Updated Remote Abstract By Zotero');
  });

  it('3. Three-Way Conflict Detection & Resolution Workflow', async () => {
    const tenant = await harness.seedWorkspaceFixture();
    syncPolicy.setWorkspaceOverride(tenant.workspaceId, {
      zoteroTwoWaySync: true,
    });

    const connection = await connectionService.createConnection(
      tenant.workspaceId,
      tenant.ownerUserId,
      {
        apiKey: 'VALID_PUSH_KEY_999',
        zoteroUserId: '999111',
      },
    );

    const binding = await harness.prisma.zoteroBinding.create({
      data: {
        connectionId: connection.id,
        workspaceId: tenant.workspaceId,
        remoteLibraryType: 'user',
        remoteLibraryId: '999111',
        syncDirection: 'two_way',
      },
    });

    const item = await harness.prisma.catalogItem.create({
      data: {
        workspaceId: tenant.workspaceId,
        title: 'Base Title',
        abstract: 'Base Abstract',
        uploadedById: tenant.ownerUserId,
        filename: 'base.pdf',
        fileUrl: 'https://test.local/base.pdf',
      },
    });

    const remoteKey = 'ZOTERO_CONFLICT_MANUAL_02';
    const itemBinding = await harness.prisma.zoteroItemBinding.create({
      data: {
        bindingId: binding.id,
        workspaceId: tenant.workspaceId,
        entityType: 'item',
        entityId: item.id,
        remoteKey,
        remoteVersion: BigInt(20),
        baseSnapshot: {
          title: 'Base Title',
          abstractNote: 'Base Abstract',
        },
        syncState: 'synced',
      },
    });

    // Local changes title to "Flux Title"
    await harness.prisma.catalogItem.update({
      where: { id: item.id },
      data: { title: 'Flux Conflicting Title' },
    });

    // Remote changed title to "Zotero Title"
    mockConnector.remoteStateMap.set(remoteKey, {
      key: remoteKey,
      version: 22,
      data: {
        key: remoteKey,
        version: 22,
        title: 'Zotero Conflicting Title',
        abstractNote: 'Base Abstract',
      },
    });

    mockConnector.simulateConflictOnKey = remoteKey;

    // Push detects same-field conflict
    const conflictResult = await pushWorker.pushItem(
      tenant.workspaceId,
      binding.id,
      item.id,
    );

    expect(conflictResult.success).toBe(false);
    expect(conflictResult.status).toBe('conflict');
    expect(conflictResult.conflictDetails).toHaveLength(1);
    expect(conflictResult.conflictDetails[0].field).toBe('title');

    // Binding is marked as conflict
    const dbBindingConflict = await harness.prisma.zoteroItemBinding.findUnique(
      {
        where: { id: itemBinding.id },
      },
    );
    expect(dbBindingConflict?.syncState).toBe('conflict');

    // User resolves conflict via resolveConflict() choosing merged resolution
    const resolvedResult = await pushWorker.resolveConflict(
      tenant.workspaceId,
      binding.id,
      item.id,
      {
        title: 'Master Resolved Title (Human Choice)',
        abstractNote: 'Base Abstract',
      },
    );

    expect(resolvedResult.success).toBe(true);
    expect(resolvedResult.status).toBe('synced');

    const dbBindingResolved = await harness.prisma.zoteroItemBinding.findUnique(
      {
        where: { id: itemBinding.id },
      },
    );
    expect(dbBindingResolved?.syncState).toBe('synced');
  });

  it('4. Kill-Switch & Policy: halts outgoing push when disabled without failing local ops', async () => {
    const tenant = await harness.seedWorkspaceFixture();

    // Disable push globally
    await syncPolicy.setGlobalPushKillSwitch(true);

    const result = await pushWorker.pushItem(
      tenant.workspaceId,
      'any-binding',
      'any-item',
    );

    expect(result.success).toBe(false);
    expect(result.status).toBe('skipped');

    // Reset kill-switch
    await syncPolicy.setGlobalPushKillSwitch(false);
  });

  it('5. Read-Only Binding Protection: read_only binding skips push without invoking connector (Requirement A)', async () => {
    const tenant = await harness.seedWorkspaceFixture();
    syncPolicy.setWorkspaceOverride(tenant.workspaceId, {
      zoteroTwoWaySync: true,
    });

    const connection = await connectionService.createConnection(
      tenant.workspaceId,
      tenant.ownerUserId,
      {
        apiKey: 'VALID_PUSH_KEY_999',
        zoteroUserId: '999111',
      },
    );

    const binding = await harness.prisma.zoteroBinding.create({
      data: {
        connectionId: connection.id,
        workspaceId: tenant.workspaceId,
        remoteLibraryType: 'user',
        remoteLibraryId: '999111',
        syncDirection: 'read_only', // READ ONLY
      },
    });

    const item = await harness.prisma.catalogItem.create({
      data: {
        workspaceId: tenant.workspaceId,
        title: 'Read-Only Test Paper',
        abstract: 'Abstract',
        uploadedById: tenant.ownerUserId,
        filename: 'readonly.pdf',
        fileUrl: 'https://test.local/readonly.pdf',
      },
    });

    const pushCountBefore = mockConnector.pushAttempts;

    const result = await pushWorker.pushItem(
      tenant.workspaceId,
      binding.id,
      item.id,
    );

    expect(result.success).toBe(false);
    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('binding_read_only');
    expect(mockConnector.pushAttempts).toBe(pushCountBefore); // Zero network calls!
  });

  it('6. Controlled Two-Way Switch & Audit Outbox (Requirement B)', async () => {
    const tenant = await harness.seedWorkspaceFixture();
    syncPolicy.setWorkspaceOverride(tenant.workspaceId, {
      zoteroTwoWaySync: true,
    });

    const connection = await connectionService.createConnection(
      tenant.workspaceId,
      tenant.ownerUserId,
      {
        apiKey: 'VALID_PUSH_KEY_999',
        zoteroUserId: '999111',
      },
    );

    const binding = await harness.prisma.zoteroBinding.create({
      data: {
        connectionId: connection.id,
        workspaceId: tenant.workspaceId,
        remoteLibraryType: 'user',
        remoteLibraryId: '999111',
        syncDirection: 'read_only',
      },
    });

    // Update to two_way
    const updated = await connectionService.updateBindingSyncDirection(
      tenant.workspaceId,
      binding.id,
      'two_way',
      tenant.ownerUserId,
    );

    expect(updated.syncDirection).toBe('two_way');

    // Verify Audit Outbox Event
    const outbox = await harness.prisma.outboxEvent.findFirst({
      where: {
        workspaceId: tenant.workspaceId,
        eventType: 'library.zotero.sync_direction_updated',
      },
    });

    expect(outbox).not.toBeNull();
    expect((outbox?.payload as any).newDirection).toBe('two_way');
  });

  it('7. Delete Propagation: propagates local deletion to Zotero with version precondition (Requirement I)', async () => {
    const tenant = await harness.seedWorkspaceFixture();
    syncPolicy.setWorkspaceOverride(tenant.workspaceId, {
      zoteroTwoWaySync: true,
    });

    const connection = await connectionService.createConnection(
      tenant.workspaceId,
      tenant.ownerUserId,
      {
        apiKey: 'VALID_PUSH_KEY_999',
        zoteroUserId: '999111',
      },
    );

    const binding = await harness.prisma.zoteroBinding.create({
      data: {
        connectionId: connection.id,
        workspaceId: tenant.workspaceId,
        remoteLibraryType: 'user',
        remoteLibraryId: '999111',
        syncDirection: 'two_way',
      },
    });

    const remoteKey = 'DELETE_ITEM_KEY_999';
    await harness.prisma.zoteroItemBinding.create({
      data: {
        bindingId: binding.id,
        workspaceId: tenant.workspaceId,
        entityType: 'item',
        entityId: 'item-del-1',
        remoteKey,
        remoteVersion: BigInt(30),
        syncState: 'synced',
      },
    });

    const result = await pushWorker.pushDeletedItem(
      tenant.workspaceId,
      binding.id,
      'item-del-1',
      remoteKey,
      BigInt(30),
    );

    expect(result.success).toBe(true);
    expect(result.status).toBe('deleted');

    // Binding is deleted
    const dbBinding = await harness.prisma.zoteroItemBinding.findUnique({
      where: {
        bindingId_remoteKey: {
          bindingId: binding.id,
          remoteKey,
        },
      },
    });
    expect(dbBinding).toBeNull();

    // Outbox event is emitted
    const outbox = await harness.prisma.outboxEvent.findFirst({
      where: {
        workspaceId: tenant.workspaceId,
        eventType: 'library.zotero.item_deleted_pushed',
      },
    });
    expect(outbox).not.toBeNull();
  });
});
