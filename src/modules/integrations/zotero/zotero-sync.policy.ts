import {
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../../../core/database/prisma.service';

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
  private readonly workspaceFlagOverrides = new Map<
    string,
    { zoteroTwoWaySync?: boolean }
  >();
  private globalPushKillSwitch = false;
  private globalKillSwitchReason?: string;
  private globalKillSwitchChangedBy?: string;
  private globalKillSwitchChangedAt?: string;

  constructor(private readonly prisma?: PrismaService) {}

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
        where: { deletedAt: null },
        select: { id: true, settings: true },
      });

      for (const ws of workspaces) {
        const settings = (ws.settings as Record<string, any>) || {};
        if (settings.zoteroPushDisabled === true) {
          this.disabledWorkspaces.set(ws.id, {
            reason: settings.zoteroPushDisabledReason,
            changedBy: settings.zoteroPushDisabledBy,
            changedAt:
              settings.zoteroPushDisabledAt || new Date().toISOString(),
          });
        }
      }

      this.logger.log(
        `Hydrated Zotero policies: globalPaused=${this.globalPushKillSwitch}, pausedWorkspacesCount=${this.disabledWorkspaces.size}`,
      );
    } catch (err: any) {
      // Fail-closed invariant on database outage
      this.globalPushKillSwitch = true;
      this.globalKillSwitchReason = `Database unavailable: ${err.message}`;
      this.logger.error(
        `Failed to hydrate Zotero policies from database: ${err.message}. Enforcing fail-closed kill switch.`,
      );
    }
  }

  /**
   * Calculates exponential backoff with full jitter to avoid thundering herd.
   */
  calculateBackoffDelay(
    attempt: number,
    options: BackoffPolicyOptions = {},
  ): number {
    const initialDelay = options.initialDelayMs || 1000;
    const maxDelay = options.maxDelayMs || 60000;
    const factor = options.backoffFactor || 2;

    const calculated = initialDelay * Math.pow(factor, attempt);
    const capped = Math.min(calculated, maxDelay);

    // Full jitter between 0 and capped delay
    return Math.floor(Math.random() * capped);
  }

  /**
   * Evaluates if an error should trigger a retry attempt.
   */
  isRetryableError(error: any): boolean {
    if (!error) return false;

    // HTTP 429 Rate Limit or 5xx Server Errors
    const status = error.status || error.response?.status;
    if (status === 429) return true;
    if (status >= 500 && status <= 599) return true;

    // Network disconnection / timeouts
    const code = error.code || error.cause?.code;
    const transientCodes = [
      'ETIMEDOUT',
      'ECONNRESET',
      'ECONNREFUSED',
      'EAI_AGAIN',
    ];
    if (transientCodes.includes(code)) return true;

    return false;
  }

  /**
   * Allows setting workspace-level feature flag overrides (e.g. for testing or per-tenant rollout).
   */
  setWorkspaceOverride(
    workspaceId: string,
    flags: { zoteroTwoWaySync?: boolean },
  ): void {
    const current = this.workspaceFlagOverrides.get(workspaceId) || {};
    this.workspaceFlagOverrides.set(workspaceId, { ...current, ...flags });
  }

  clearWorkspaceOverride(workspaceId: string): void {
    this.workspaceFlagOverrides.delete(workspaceId);
  }

  isTwoWaySyncEnabled(workspaceId?: string): boolean {
    if (workspaceId && this.workspaceFlagOverrides.has(workspaceId)) {
      const override = this.workspaceFlagOverrides.get(workspaceId);
      if (override?.zoteroTwoWaySync !== undefined) {
        return override.zoteroTwoWaySync;
      }
    }
    const envVal = process.env.LIBRARY_ZOTERO_TWO_WAY_SYNC;
    return envVal === 'true' || envVal === '1';
  }

  /**
   * Checks whether push sync is globally enabled or per-workspace enabled.
   */
  isPushEnabled(workspaceId: string): boolean {
    if (this.globalPushKillSwitch) return false;
    if (this.disabledWorkspaces.has(workspaceId)) return false;
    return this.isTwoWaySyncEnabled(workspaceId);
  }

  /**
   * Returns complete kill-switch status for UI inspection.
   */
  getKillSwitchStatus(workspaceId: string): KillSwitchStatus {
    const wsInfo = this.disabledWorkspaces.get(workspaceId);
    return {
      globalDisabled: this.globalPushKillSwitch,
      workspaceDisabled: !!wsInfo,
      reason: wsInfo?.reason || this.globalKillSwitchReason,
      changedBy: wsInfo?.changedBy || this.globalKillSwitchChangedBy,
      changedAt: wsInfo?.changedAt || this.globalKillSwitchChangedAt,
    };
  }

  /**
   * Direct policy state inspection against the database (bypasses in-memory cache).
   */
  async checkEffectivePolicyDirect(
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
   * Alias for controller backwards compatibility.
   */
  async getFreshKillSwitchStatus(
    workspaceId: string,
  ): Promise<KillSwitchStatus> {
    return this.checkEffectivePolicyDirect(workspaceId);
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

    if (!this.isTwoWaySyncEnabled(workspaceId)) {
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
            workspaceId: 'global',
            aggregateId: 'zotero',
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

    this.globalPushKillSwitch = disabled;
    this.globalKillSwitchReason = reason;
    this.globalKillSwitchChangedBy = changedBy;
    this.globalKillSwitchChangedAt = now.toISOString();

    this.logger.warn(
      `Zotero GLOBAL push kill switch committed to DB: ${disabled} (Reason: ${reason || 'N/A'})`,
    );
  }

  /**
   * Sets workspace-specific kill switch directly into Workspace settings JSON and in-memory map.
   * Atomically updates Workspace and emits audit OutboxEvent in a transaction.
   */
  async setWorkspacePushKillSwitch(
    workspaceId: string,
    disabled: boolean,
    reason?: string,
    changedBy?: string,
  ): Promise<void> {
    const now = new Date();

    if (this.prisma) {
      await this.prisma.$transaction(async (tx) => {
        const workspace = await tx.workspace.findUnique({
          where: { id: workspaceId },
        });
        if (!workspace) {
          throw new NotFoundException(`Workspace ${workspaceId} not found`);
        }

        const settings = (workspace.settings as Record<string, any>) || {};
        const updatedSettings = {
          ...settings,
          zoteroPushDisabled: disabled,
          zoteroPushDisabledReason: reason || null,
          zoteroPushDisabledBy: changedBy || null,
          zoteroPushDisabledAt: now.toISOString(),
        };

        await tx.workspace.update({
          where: { id: workspaceId },
          data: { settings: updatedSettings },
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
              timestamp: now.toISOString(),
            },
          },
        });
      });
    }

    if (disabled) {
      this.disabledWorkspaces.set(workspaceId, {
        reason,
        changedBy,
        changedAt: now.toISOString(),
      });
    } else {
      this.disabledWorkspaces.delete(workspaceId);
    }

    this.logger.warn(
      `Zotero push kill switch for workspace ${workspaceId} committed to DB: ${disabled} (Reason: ${reason || 'N/A'})`,
    );
  }
}
