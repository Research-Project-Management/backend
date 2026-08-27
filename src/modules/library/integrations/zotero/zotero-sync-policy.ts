import {
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { LibraryFeatureFlagsService } from '../../common/library-feature-flags';
import { PrismaService } from '../../../../core/database/prisma.service';

export interface BackoffPolicyOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffFactor?: number;
}

export interface KillSwitchStatus {
  globalDisabled: boolean;
  workspaceDisabled: boolean;
  reason?: string;
  changedBy?: string;
  changedAt?: string;
}

@Injectable()
export class ZoteroSyncPolicy implements OnModuleInit {
  private readonly logger = new Logger(ZoteroSyncPolicy.name);
  private readonly disabledWorkspaces = new Map<
    string,
    { reason?: string; changedBy?: string; changedAt: string }
  >();
  private globalPushKillSwitch = false;
  private globalKillSwitchReason?: string;
  private globalKillSwitchChangedBy?: string;
  private globalKillSwitchChangedAt?: string;

  constructor(
    private readonly featureFlags: LibraryFeatureFlagsService,
    private readonly prisma?: PrismaService,
  ) {}

  async onModuleInit() {
    await this.hydratePoliciesFromDatabase();
  }

  /**
   * Hydrates global and workspace policies directly from PostgreSQL on startup.
   * On failure: fails closed for remote writes to prevent unauthorized external traffic.
   */
  async hydratePoliciesFromDatabase(): Promise<void> {
    if (!this.prisma) return;

    try {
      // 1. Hydrate global provider policy
      const globalPolicy = await this.prisma.integrationPolicy.findUnique({
        where: { provider: 'zotero' },
      });

      if (globalPolicy) {
        this.globalPushKillSwitch = globalPolicy.isPaused;
        this.globalKillSwitchReason = globalPolicy.reason || undefined;
        this.globalKillSwitchChangedBy = globalPolicy.changedBy || undefined;
        this.globalKillSwitchChangedAt =
          globalPolicy.changedAt?.toISOString() || undefined;
      } else {
        this.globalPushKillSwitch = false;
        this.globalKillSwitchReason = undefined;
      }

      // 2. Hydrate workspace-level paused settings
      const workspaces = await this.prisma.workspace.findMany({
        where: {
          settings: {
            path: ['zoteroPushDisabled'],
            equals: true,
          },
        },
        select: {
          id: true,
          settings: true,
        },
      });

      this.disabledWorkspaces.clear();
      for (const ws of workspaces) {
        const s = (ws.settings as Record<string, any>) || {};
        if (s.zoteroPushDisabled) {
          this.disabledWorkspaces.set(ws.id, {
            reason: s.zoteroPushDisabledReason,
            changedBy: s.zoteroPushDisabledBy,
            changedAt: s.zoteroPushDisabledAt || new Date().toISOString(),
          });
        }
      }

      this.logger.log(
        `Hydrated Zotero policies: globalPaused=${this.globalPushKillSwitch}, pausedWorkspacesCount=${this.disabledWorkspaces.size}`,
      );
    } catch (err: any) {
      // Fail-closed for external remote writes if DB is unreachable on startup
      this.globalPushKillSwitch = true;
      this.globalKillSwitchReason = 'Startup database hydration failed';
      this.logger.error(
        `Failed to hydrate Zotero policies from database: ${err.message}. Enforcing fail-closed kill switch.`,
      );
    }
  }

  /**
   * Checks if two-way push is enabled globally and for the specific workspace.
   */
  isPushEnabled(workspaceId: string): boolean {
    if (this.globalPushKillSwitch) {
      return false;
    }
    if (this.disabledWorkspaces.has(workspaceId)) {
      return false;
    }
    return this.featureFlags.isZoteroTwoWaySyncEnabled(workspaceId);
  }

  /**
   * Asynchronously verifies policy state against database right before executing write operations.
   * Updates in-memory cache for BOTH paused=true and paused=false to handle multi-instance updates seamlessly.
   */
  async checkEffectivePolicyDirect(workspaceId: string): Promise<boolean> {
    if (!this.prisma) {
      return this.isPushEnabled(workspaceId);
    }

    try {
      // 1. Check Global DB Policy
      const globalPolicy = await this.prisma.integrationPolicy.findUnique({
        where: { provider: 'zotero' },
      });

      if (globalPolicy?.isPaused) {
        this.globalPushKillSwitch = true;
        this.globalKillSwitchReason = globalPolicy.reason || undefined;
        this.globalKillSwitchChangedBy = globalPolicy.changedBy || undefined;
        this.globalKillSwitchChangedAt =
          globalPolicy.changedAt?.toISOString() || undefined;
        return false;
      } else {
        this.globalPushKillSwitch = false;
        this.globalKillSwitchReason = undefined;
        this.globalKillSwitchChangedBy = undefined;
        this.globalKillSwitchChangedAt = undefined;
      }

      // 2. Check Workspace DB Policy
      const ws = await this.prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { settings: true },
      });

      const s = (ws?.settings as Record<string, any>) || {};
      if (s.zoteroPushDisabled) {
        this.disabledWorkspaces.set(workspaceId, {
          reason: s.zoteroPushDisabledReason,
          changedBy: s.zoteroPushDisabledBy,
          changedAt: s.zoteroPushDisabledAt || new Date().toISOString(),
        });
        return false;
      } else {
        this.disabledWorkspaces.delete(workspaceId);
      }

      return this.featureFlags.isZoteroTwoWaySyncEnabled(workspaceId);
    } catch (err: any) {
      this.logger.error(
        `Error querying effective policy from DB: ${err.message}. Enforcing fail-closed policy for external write.`,
      );
      return false;
    }
  }

  /**
   * Returns current kill-switch status for workspace and global scope.
   */
  getKillSwitchStatus(workspaceId: string): KillSwitchStatus {
    const wsStatus = this.disabledWorkspaces.get(workspaceId);
    return {
      globalDisabled: this.globalPushKillSwitch,
      workspaceDisabled: !!wsStatus,
      reason: wsStatus?.reason || this.globalKillSwitchReason,
      changedBy: wsStatus?.changedBy || this.globalKillSwitchChangedBy,
      changedAt: wsStatus?.changedAt || this.globalKillSwitchChangedAt,
    };
  }

  /**
   * Reads fresh kill-switch status directly from PostgreSQL database.
   */
  async getFreshKillSwitchStatus(
    workspaceId: string,
  ): Promise<KillSwitchStatus> {
    if (!this.prisma) {
      return this.getKillSwitchStatus(workspaceId);
    }

    try {
      const [globalPolicy, ws] = await Promise.all([
        this.prisma.integrationPolicy.findUnique({
          where: { provider: 'zotero' },
        }),
        this.prisma.workspace.findUnique({
          where: { id: workspaceId },
          select: { settings: true },
        }),
      ]);

      const isGlobalPaused = !!globalPolicy?.isPaused;
      const s = (ws?.settings as Record<string, any>) || {};
      const isWsPaused = !!s.zoteroPushDisabled;

      return {
        globalDisabled: isGlobalPaused,
        workspaceDisabled: isWsPaused,
        reason: s.zoteroPushDisabledReason || globalPolicy?.reason || undefined,
        changedBy:
          s.zoteroPushDisabledBy || globalPolicy?.changedBy || undefined,
        changedAt:
          s.zoteroPushDisabledAt ||
          globalPolicy?.changedAt?.toISOString() ||
          undefined,
      };
    } catch {
      return this.getKillSwitchStatus(workspaceId);
    }
  }

  /**
   * Validates if a binding is fully eligible for two-way push operations.
   */
  validatePushEligibility(
    workspaceId: string,
    binding: {
      workspaceId: string;
      syncDirection: string;
      connection?: { status: string } | null;
    },
  ): { eligible: boolean; reason?: string } {
    if (binding.workspaceId !== workspaceId) {
      return { eligible: false, reason: 'cross_workspace_binding_mismatch' };
    }

    if (binding.syncDirection !== 'two_way') {
      return { eligible: false, reason: 'binding_read_only' };
    }

    if (binding.connection && binding.connection.status !== 'active') {
      return { eligible: false, reason: 'connection_inactive' };
    }

    if (this.globalPushKillSwitch) {
      return { eligible: false, reason: 'global_kill_switch_active' };
    }

    if (this.disabledWorkspaces.has(workspaceId)) {
      return { eligible: false, reason: 'workspace_kill_switch_active' };
    }

    if (!this.featureFlags.isZoteroTwoWaySyncEnabled(workspaceId)) {
      return { eligible: false, reason: 'feature_flag_disabled' };
    }

    return { eligible: true };
  }

  /**
   * Activates global kill switch to instantly halt all outgoing push operations across the entire platform.
   * Atomically writes IntegrationPolicy and OutboxEvent in a database transaction without swallowing errors.
   */
  async setGlobalPushKillSwitch(
    disabled: boolean,
    reason?: string,
    changedBy?: string,
  ): Promise<void> {
    const now = new Date();

    if (this.prisma) {
      await this.prisma.$transaction(async (tx) => {
        await tx.integrationPolicy.upsert({
          where: { provider: 'zotero' },
          update: {
            isPaused: disabled,
            reason: reason || null,
            changedBy: changedBy || null,
            changedAt: now,
          },
          create: {
            provider: 'zotero',
            isPaused: disabled,
            reason: reason || null,
            changedBy: changedBy || null,
            changedAt: now,
          },
        });

        await tx.outboxEvent.create({
          data: {
            workspaceId: null,
            aggregateId: 'zotero-kill-switch',
            eventType: 'library.zotero.global_kill_switch_toggled',
            payload: {
              disabled,
              reason,
              changedBy,
              timestamp: now.toISOString(),
            },
          },
        });
      });
    }

    // Update in-memory state only after transaction commits successfully
    this.globalPushKillSwitch = disabled;
    this.globalKillSwitchReason = reason;
    this.globalKillSwitchChangedBy = changedBy;
    this.globalKillSwitchChangedAt = now.toISOString();

    this.logger.warn(
      `Zotero GLOBAL push kill switch committed to DB: ${disabled} (Reason: ${reason || 'Operator Action'})`,
    );
  }

  /**
   * Disables push operations for a specific workspace and persists state in database.
   * Validates workspace existence before performing atomic updates.
   */
  async setWorkspacePushKillSwitch(
    workspaceId: string,
    disabled: boolean,
    reason?: string,
    changedBy?: string,
  ): Promise<void> {
    const now = new Date().toISOString();

    if (this.prisma) {
      await this.prisma.$transaction(async (tx) => {
        const ws = await tx.workspace.findUnique({
          where: { id: workspaceId },
        });

        if (!ws) {
          throw new NotFoundException(`Workspace ${workspaceId} not found`);
        }

        const currentSettings = (ws.settings as Record<string, any>) || {};
        await tx.workspace.update({
          where: { id: workspaceId },
          data: {
            settings: {
              ...currentSettings,
              zoteroPushDisabled: disabled,
              zoteroPushDisabledReason: reason || null,
              zoteroPushDisabledBy: changedBy || null,
              zoteroPushDisabledAt: now,
            },
          },
        });

        await tx.outboxEvent.create({
          data: {
            workspaceId,
            aggregateId: workspaceId,
            eventType: 'library.zotero.workspace_kill_switch_toggled',
            payload: {
              workspaceId,
              disabled,
              reason,
              changedBy,
              timestamp: now,
            },
          },
        });
      });
    }

    // Update in-memory state only after transaction commits successfully
    if (disabled) {
      this.disabledWorkspaces.set(workspaceId, {
        reason,
        changedBy,
        changedAt: now,
      });
    } else {
      this.disabledWorkspaces.delete(workspaceId);
    }

    this.logger.warn(
      `Zotero push kill switch for workspace ${workspaceId} committed to DB: ${disabled} (Reason: ${reason || 'User/Operator Action'})`,
    );
  }

  /**
   * Calculates exponential backoff with full jitter for rate-limited requests.
   */
  calculateBackoffDelay(
    retryCount: number,
    options: BackoffPolicyOptions = {},
  ): number {
    const initialDelay = options.initialDelayMs ?? 1000;
    const maxDelay = options.maxDelayMs ?? 60000;
    const factor = options.backoffFactor ?? 2;

    const baseDelay = Math.min(
      maxDelay,
      initialDelay * Math.pow(factor, retryCount),
    );

    // Full jitter: random uniform value between 0 and baseDelay
    return Math.floor(Math.random() * baseDelay);
  }
}
