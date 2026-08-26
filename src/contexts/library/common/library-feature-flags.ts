import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface ILibraryFeatureFlags {
  /**
   * Dual-write to both legacy CatalogItem and canonical tables during transition.
   * Default: true
   */
  dualWrite: boolean;

  /**
   * Read from canonical tables first; fallback to legacy if not found.
   * Default: false (turned on after backfill validation)
   */
  readNew: boolean;

  /**
   * Serve legacy `/api/library/...` route aliases with Deprecation/Sunset headers.
   * Default: true
   */
  legacyRoute: boolean;

  /**
   * Emit transactional outbox events on all mutating operations.
   * Default: true
   */
  syncOutboxEnabled: boolean;

  /**
   * Enable Zotero external adapter integration endpoints.
   * Default: false
   */
  zoteroAdapterEnabled: boolean;
}

@Injectable()
export class LibraryFeatureFlagsService {
  private readonly logger = new Logger(LibraryFeatureFlagsService.name);
  private readonly workspaceOverrides = new Map<
    string,
    Partial<ILibraryFeatureFlags>
  >();

  constructor(private readonly configService?: ConfigService) {}

  /**
   * Resolves the effective feature flags for a given workspace.
   */
  getFlags(workspaceId?: string): ILibraryFeatureFlags {
    const globalDefaults: ILibraryFeatureFlags = {
      dualWrite: this.parseBooleanEnv('LIBRARY_DUAL_WRITE', true),
      readNew: this.parseBooleanEnv('LIBRARY_READ_NEW', false),
      legacyRoute: this.parseBooleanEnv('LIBRARY_LEGACY_ROUTE', true),
      syncOutboxEnabled: this.parseBooleanEnv('LIBRARY_SYNC_OUTBOX', true),
      zoteroAdapterEnabled: this.parseBooleanEnv(
        'LIBRARY_ZOTERO_ADAPTER',
        false,
      ),
    };

    if (!workspaceId || !this.workspaceOverrides.has(workspaceId)) {
      return globalDefaults;
    }

    const overrides = this.workspaceOverrides.get(workspaceId)!;
    return {
      ...globalDefaults,
      ...overrides,
    };
  }

  isDualWriteEnabled(workspaceId?: string): boolean {
    return this.getFlags(workspaceId).dualWrite;
  }

  isReadNewEnabled(workspaceId?: string): boolean {
    return this.getFlags(workspaceId).readNew;
  }

  isLegacyRouteEnabled(): boolean {
    return this.getFlags().legacyRoute;
  }

  isSyncOutboxEnabled(workspaceId?: string): boolean {
    return this.getFlags(workspaceId).syncOutboxEnabled;
  }

  isZoteroAdapterEnabled(workspaceId?: string): boolean {
    return this.getFlags(workspaceId).zoteroAdapterEnabled;
  }

  setWorkspaceOverride(
    workspaceId: string,
    flags: Partial<ILibraryFeatureFlags>,
  ): void {
    this.logger.log(
      `Setting library feature flag overrides for workspace ${workspaceId}: ${JSON.stringify(flags)}`,
    );
    const current = this.workspaceOverrides.get(workspaceId) || {};
    this.workspaceOverrides.set(workspaceId, { ...current, ...flags });
  }

  clearWorkspaceOverride(workspaceId: string): void {
    this.logger.log(
      `Cleared library feature flag overrides for workspace ${workspaceId}`,
    );
    this.workspaceOverrides.delete(workspaceId);
  }

  private parseBooleanEnv(key: string, defaultValue: boolean): boolean {
    if (!this.configService) {
      const val = process.env[key];
      if (val === undefined) return defaultValue;
      return val === 'true' || val === '1';
    }
    const val = this.configService.get<string | boolean>(key);
    if (val === undefined || val === null) return defaultValue;
    if (typeof val === 'boolean') return val;
    return val === 'true' || val === '1';
  }
}
