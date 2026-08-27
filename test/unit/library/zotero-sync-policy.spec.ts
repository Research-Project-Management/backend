import { ZoteroSyncPolicy } from '../../../src/modules/library/integrations/zotero/zotero-sync-policy';
import { NotFoundException } from '@nestjs/common';

describe('ZoteroSyncPolicy (PostgreSQL Persistence & Kill-Switch)', () => {
  let policy: ZoteroSyncPolicy;
  let mockFlags: any;
  let mockPrisma: any;

  beforeEach(() => {
    mockFlags = {
      isZoteroTwoWaySyncEnabled: jest.fn().mockReturnValue(true),
    };

    mockPrisma = {
      integrationPolicy: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({}),
      },
      workspace: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockResolvedValue({}),
      },
      outboxEvent: {
        create: jest.fn().mockResolvedValue({}),
      },
      $transaction: jest
        .fn()
        .mockImplementation((cb: (arg: any) => Promise<any>) => cb(mockPrisma)),
    };

    policy = new ZoteroSyncPolicy(mockFlags, mockPrisma);
  });

  it('hydrates global and workspace policies on module init', async () => {
    mockPrisma.integrationPolicy.findUnique.mockResolvedValue({
      provider: 'zotero',
      isPaused: true,
      reason: 'Global maintenance',
      changedBy: 'admin-1',
      changedAt: new Date(),
    });

    mockPrisma.workspace.findMany.mockResolvedValue([
      {
        id: 'ws-paused',
        settings: {
          zoteroPushDisabled: true,
          zoteroPushDisabledReason: 'Tenant quota limit',
        },
      },
    ]);

    await policy.onModuleInit();

    expect(policy.isPushEnabled('ws-normal')).toBe(false); // Global is paused
  });

  it('fails closed for remote writes when startup database hydration fails', async () => {
    mockPrisma.integrationPolicy.findUnique.mockRejectedValue(
      new Error('PostgreSQL connection timeout'),
    );

    await policy.onModuleInit();

    // Must fail closed: push disabled
    expect(policy.isPushEnabled('ws-any')).toBe(false);
    expect(policy.getKillSwitchStatus('ws-any').globalDisabled).toBe(true);
    expect(policy.getKillSwitchStatus('ws-any').reason).toBe(
      'Startup database hydration failed',
    );
  });

  it('atomically commits global push kill switch in a transaction', async () => {
    await policy.setGlobalPushKillSwitch(
      true,
      'Critical CVE incident',
      'sec-ops',
    );

    expect(mockPrisma.$transaction).toHaveBeenCalled();
    expect(mockPrisma.integrationPolicy.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { provider: 'zotero' },
        update: expect.objectContaining({
          isPaused: true,
          reason: 'Critical CVE incident',
        }),
      }),
    );
    expect(mockPrisma.outboxEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          aggregateId: 'zotero-kill-switch',
          eventType: 'library.zotero.global_kill_switch_toggled',
        }),
      }),
    );

    const status = policy.getKillSwitchStatus('ws-any');
    expect(status.globalDisabled).toBe(true);
    expect(status.reason).toBe('Critical CVE incident');
  });

  it('atomically commits workspace-level kill switch in a transaction', async () => {
    mockPrisma.workspace.findUnique.mockResolvedValue({
      id: 'ws-1',
      settings: {},
    });

    await policy.setWorkspacePushKillSwitch(
      'ws-1',
      true,
      'Rate limited by Zotero',
    );

    expect(mockPrisma.$transaction).toHaveBeenCalled();
    expect(mockPrisma.workspace.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'ws-1' },
      }),
    );

    const status = policy.getKillSwitchStatus('ws-1');
    expect(status.workspaceDisabled).toBe(true);
    expect(status.reason).toBe('Rate limited by Zotero');
  });

  it('throws NotFoundException when setting workspace kill switch on non-existent workspace', async () => {
    mockPrisma.workspace.findUnique.mockResolvedValue(null);

    await expect(
      policy.setWorkspacePushKillSwitch('ws-missing', true, 'Test'),
    ).rejects.toThrow(NotFoundException);
  });

  it('synchronizes cache bidirectionally via checkEffectivePolicyDirect', async () => {
    // 1. Initial state: enabled
    mockPrisma.integrationPolicy.findUnique.mockResolvedValue({
      provider: 'zotero',
      isPaused: true,
    });
    mockPrisma.workspace.findUnique.mockResolvedValue({
      id: 'ws-1',
      settings: {},
    });

    const isDirectEnabled1 = await policy.checkEffectivePolicyDirect('ws-1');
    expect(isDirectEnabled1).toBe(false);
    expect(policy.isPushEnabled('ws-1')).toBe(false);

    // 2. Another instance unpauses in DB
    mockPrisma.integrationPolicy.findUnique.mockResolvedValue({
      provider: 'zotero',
      isPaused: false,
    });

    const isDirectEnabled2 = await policy.checkEffectivePolicyDirect('ws-1');
    expect(isDirectEnabled2).toBe(true);
    expect(policy.isPushEnabled('ws-1')).toBe(true); // Cache updated to enabled!
  });
});
