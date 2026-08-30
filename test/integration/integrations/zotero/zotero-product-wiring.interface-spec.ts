import { LibraryTestHarness } from '../../library/library-test-harness';
import { ZoteroSyncPolicy } from '../../../../src/modules/integrations/zotero/zotero-sync.policy';
import { ZoteroConnectionService } from '../../../../src/modules/integrations/zotero/zotero-connection.service';
import { ZoteroFileConnector } from '../../../../src/modules/integrations/zotero/zotero-file.connector';
import { UrlCaptureProvider } from '../../../../src/modules/library/ingestion/providers/url-capture.provider';
import { IngestionService } from '../../../../src/modules/library/ingestion/ingestion.service';
import { CatalogService } from '../../../../src/modules/library/catalog/catalog.service';

jest.setTimeout(60000);

describe('Zotero Product Wiring & Release Verification (Steps 1-12)', () => {
  let harness: LibraryTestHarness;
  let syncPolicy: ZoteroSyncPolicy;
  let connectionService: ZoteroConnectionService;
  let fileConnector: ZoteroFileConnector;
  let urlCaptureConnector: UrlCaptureProvider;
  let ingestionService: IngestionService;
  let catalogService: CatalogService;
  let workspaceId: string;
  let userId: string;

  beforeAll(async () => {
    harness = await LibraryTestHarness.create();
    const tenant = await harness.seedWorkspaceFixture();
    workspaceId = tenant.workspaceId;
    userId = tenant.ownerUserId;

    syncPolicy = harness.moduleRef.get(ZoteroSyncPolicy);
    syncPolicy.setWorkspaceOverride(workspaceId, {
      zoteroTwoWaySync: true,
    });
    connectionService = harness.moduleRef.get(ZoteroConnectionService);
    fileConnector = new ZoteroFileConnector(syncPolicy);
    urlCaptureConnector = new UrlCaptureProvider();
    catalogService = harness.moduleRef.get(CatalogService);

    ingestionService = harness.moduleRef.get(IngestionService);
  });

  afterAll(async () => {
    await harness.close();
  });

  describe('Step 7: Persistent Kill-Switch & Policy Integrity', () => {
    it('persists workspace kill-switch in database and halts push operations', async () => {
      // 1. Initially enabled
      expect(syncPolicy.isPushEnabled(workspaceId)).toBe(true);

      // 2. Set workspace kill switch
      await syncPolicy.setWorkspacePushKillSwitch(
        workspaceId,
        true,
        'Operator Emergency Maintenance Drill',
        userId,
      );

      // 3. Status reflects disabled
      const status = syncPolicy.getKillSwitchStatus(workspaceId);
      expect(status.workspaceDisabled).toBe(true);
      expect(status.reason).toBe('Operator Emergency Maintenance Drill');

      // 4. Policy check immediately returns false
      expect(syncPolicy.isPushEnabled(workspaceId)).toBe(false);

      // 5. Check outbox audit event
      const outboxEvent = await harness.prisma.outboxEvent.findFirst({
        where: {
          workspaceId,
          eventType: 'library.zotero.workspace_kill_switch_toggled',
        },
        orderBy: { createdAt: 'desc' },
      });
      expect(outboxEvent).toBeDefined();
      expect((outboxEvent?.payload as any)?.disabled).toBe(true);
      expect((outboxEvent?.payload as any)?.reason).toBe(
        'Operator Emergency Maintenance Drill',
      );

      // 6. Reset kill switch
      await syncPolicy.setWorkspacePushKillSwitch(workspaceId, false);
      expect(syncPolicy.isPushEnabled(workspaceId)).toBe(true);
    });

    it('handles global platform kill-switch across all workspaces', async () => {
      await syncPolicy.setGlobalPushKillSwitch(
        true,
        'Platform-wide incident',
        'operator_admin',
      );

      expect(syncPolicy.isPushEnabled(workspaceId)).toBe(false);

      const globalOutbox = await harness.prisma.outboxEvent.findFirst({
        where: {
          workspaceId: null,
          eventType: 'library.zotero.global_kill_switch_toggled',
        },
        orderBy: { createdAt: 'desc' },
      });
      expect(globalOutbox).toBeDefined();

      await syncPolicy.setGlobalPushKillSwitch(false);
      expect(syncPolicy.isPushEnabled(workspaceId)).toBe(true);
    });
  });

  describe('Step 5: Conflict Inbox & Pending Pushes Queries', () => {
    let connectionId: string;
    let bindingId: string;
    let catalogItemId: string;

    beforeAll(async () => {
      const conn = await connectionService.createConnection(
        workspaceId,
        userId,
        {
          apiKey: 'TEST_API_KEY_QUERY_VERIFICATION',
          accountName: 'Query Test Zotero',
          zoteroUserId: 'user_queries_123',
        },
      );
      connectionId = conn.id;

      const binding = await connectionService.createBinding(workspaceId, {
        connectionId,
        remoteLibraryType: 'user',
        remoteLibraryId: 'user_queries_123',
      });
      bindingId = binding.id;

      const item = await catalogService.createItem(workspaceId, {
        title: 'Conflict Test Item for Inbox',
        itemType: 'journalArticle',
        uploadedById: userId,
      });
      catalogItemId = item.id;
    });

    it('lists conflicts with resolved titles and base/remote snapshots', async () => {
      // Create a conflict item binding
      await harness.prisma.zoteroItemBinding.create({
        data: {
          workspaceId,
          bindingId,
          entityType: 'item',
          entityId: catalogItemId,
          remoteKey: 'CONFLICT_REMOTE_KEY_1',
          remoteVersion: BigInt(25),
          syncState: 'conflict',
          baseSnapshot: { title: 'Original Base Title', year: 2023 },
          rawPayload: { title: 'Zotero Remote Updated Title', year: 2024 },
        },
      });

      const conflicts = await connectionService.listConflicts(
        workspaceId,
        bindingId,
      );
      expect(conflicts.length).toBeGreaterThanOrEqual(1);

      const found = conflicts.find(
        (c) => c.remoteKey === 'CONFLICT_REMOTE_KEY_1',
      );
      expect(found).toBeDefined();
      expect(found?.title).toBe('Conflict Test Item for Inbox');
      expect(found?.syncState).toBe('conflict');
      expect((found?.rawPayload as any)?.title).toBe(
        'Zotero Remote Updated Title',
      );
    });

    it('lists pending pushes accurately for queued items', async () => {
      const pending = await connectionService.listPendingPushes(
        workspaceId,
        bindingId,
      );
      expect(pending.length).toBeGreaterThanOrEqual(1);
      expect(pending.some((p) => p.remoteKey === 'CONFLICT_REMOTE_KEY_1')).toBe(
        true,
      );
    });
  });

  describe('Step 8: Zotero Storage Quota & File Protocol Invariants', () => {
    it('returns isUnavailable: true without fake 300MB fallback when upstream fails', async () => {
      const quota = await fileConnector.getStorageQuota(
        'INVALID_MOCK_KEY',
        'nonexistent_user',
      );
      expect(quota.isUnavailable).toBe(true);
      expect(quota.total).toBe(0);
      expect(quota.used).toBe(0);
    });

    it('rejects file uploads exceeding 50MB maximum payload limit', async () => {
      const oversizedBuffer = Buffer.alloc(51 * 1024 * 1024); // 51MB
      const result = await fileConnector.uploadAttachment(
        'MOCK_API_KEY',
        'user',
        '12345',
        'ITEM_OVERSIZE',
        oversizedBuffer,
        'huge_file.pdf',
      );

      expect(result.success).toBe(false);
      expect(result.status).toBe('failed');
      expect(result.errorMessage).toContain('exceeds maximum allowed');
    });
  });

  describe('Step 9: URL Capture with SSRF Protection & DOI Resolution', () => {
    it('strictly blocks private IPv4 and loopback requests to prevent SSRF', async () => {
      const loopbackUrl = 'http://127.0.0.1:8080/internal-metrics';
      await expect(
        urlCaptureConnector.captureFromUrl(loopbackUrl),
      ).rejects.toThrow(/forbidden|private\/internal/i);

      const privateIpUrl = 'http://192.168.1.100/admin';
      await expect(
        urlCaptureConnector.captureFromUrl(privateIpUrl),
      ).rejects.toThrow(/forbidden|private\/internal/i);

      const awsMetadataUrl = 'http://169.254.169.254/latest/meta-data';
      await expect(
        urlCaptureConnector.captureFromUrl(awsMetadataUrl),
      ).rejects.toThrow(/forbidden|private\/internal/i);
    });

    it('confirms and commits captured URL metadata into CatalogItem atomically', async () => {
      const meta = {
        title: 'Attention Is All You Need',
        abstract:
          'The dominant sequence transduction models are based on complex recurrent...',
        doi: '10.48550/arXiv.1706.03762',
        url: 'https://arxiv.org/abs/1706.03762',
        year: 2017,
        publicationTitle: 'NeurIPS 2017',
        itemType: 'journalArticle' as const,
        creators: [
          { firstName: 'Ashish', lastName: 'Vaswani' },
          { firstName: 'Noam', lastName: 'Shazeer' },
        ],
      };

      const withToken = urlCaptureConnector.attachPreviewToken(meta, {
        workspaceId,
        userId,
      });

      const tokenHash = urlCaptureConnector.hashToken(withToken.previewToken!);
      const metadataDigest = urlCaptureConnector.calculateMetadataDigest(meta);
      await harness.prisma.capturePreview.create({
        data: {
          workspaceId,
          userId,
          sourceUrl: meta.url,
          canonicalMetadata: meta as any,
          metadataDigest,
          tokenHash,
          expiresAt: new Date(Date.now() + 15 * 60 * 1000),
        },
      });

      const confirmedRes = await ingestionService.confirmCapturedUrl(
        workspaceId,
        userId,
        {
          title: 'Attention Is All You Need',
          previewToken: withToken.previewToken!,
        },
      );
      const confirmed = confirmedRes as any;

      expect(confirmed.id).toBeDefined();
      expect(confirmed.title).toBe('Attention Is All You Need');
      expect(confirmed.doi).toBe('10.48550/arXiv.1706.03762');

      // Verify outbox publication
      const outbox = await harness.prisma.outboxEvent.findFirst({
        where: {
          workspaceId,
          aggregateId: confirmed.id,
          eventType: 'library.item.created',
        },
      });
      expect(outbox).toBeDefined();
      const payload = outbox?.payload as any;
      expect(payload?.itemId).toBe(confirmed.id);
      expect(payload?.workspaceId).toBe(workspaceId);
      expect(payload?.title).toBe('Attention Is All You Need');
      expect(payload?.source).toBe('url');
    });
  });
});
