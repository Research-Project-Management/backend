import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { resolveServiceUrl } from '@/core/utils/public-urls';
import type { LivePresenceUser } from '@/modules/pages/core/ports/live-collaboration.port';
import {
  REALTIME_INTERNAL_KEY_HEADER,
  resolveRealtimeInternalKey,
} from './auth';

export const REALTIME_CONTROL_CLIENT_OPTIONS =
  'REALTIME_CONTROL_CLIENT_OPTIONS' as const;

export interface RealtimeControlClientOptions {
  baseUrl?: string;
  internalKey?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  flushTimeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_FLUSH_TIMEOUT_MS = 15_000;

@Injectable()
export class RealtimeControlClient {
  private readonly logger = new Logger(RealtimeControlClient.name);
  private readonly baseUrl: string;
  private readonly remoteEnabled: boolean;
  private readonly internalKey: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly flushTimeoutMs: number;

  constructor(
    @Optional() config?: ConfigService,
    @Optional()
    @Inject(REALTIME_CONTROL_CLIENT_OPTIONS)
    options?: RealtimeControlClientOptions,
  ) {
    const configuredUrl = (
      options?.baseUrl ??
      config?.get<string>('REALTIME_SERVICE_URL') ??
      process.env.REALTIME_SERVICE_URL ??
      ''
    ).trim();
    const nodeEnv = config?.get<string>('NODE_ENV') ?? process.env.NODE_ENV;

    if (!configuredUrl && nodeEnv === 'test') {
      this.remoteEnabled = false;
      this.baseUrl = '';
    } else {
      this.baseUrl = resolveServiceUrl(
        'REALTIME_SERVICE_URL',
        configuredUrl,
        'http://127.0.0.1:18314',
      ).replace(/\/+$/, '');
      this.remoteEnabled = true;
    }

    this.internalKey =
      options?.internalKey ?? resolveRealtimeInternalKey(config);
    this.fetchFn = options?.fetchFn ?? globalThis.fetch;
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.flushTimeoutMs = options?.flushTimeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS;
  }

  public isRemoteEnabled(): boolean {
    return this.remoteEnabled;
  }

  public getBaseUrl(): string {
    return this.baseUrl;
  }

  public async flushDocs(
    projectId: string,
    docIds: string[],
  ): Promise<string[]> {
    if (!this.remoteEnabled || !projectId) {
      return [];
    }

    try {
      const data = await this.request<{ flushedDocIds?: string[] }>(
        'POST',
        '/internal/realtime/flush',
        { projectId, docIds },
        this.flushTimeoutMs,
      );
      return Array.isArray(data?.flushedDocIds) ? data.flushedDocIds : [];
    } catch (err: unknown) {
      this.logger.warn(
        `Realtime remote flushDocs failed for project ${projectId}: ${this.errorMessage(err)}`,
      );
      return [];
    }
  }

  public async applyExternalText(
    projectId: string,
    docId: string,
    text: string,
  ): Promise<boolean> {
    if (!this.remoteEnabled || !projectId || !docId) {
      return false;
    }

    try {
      const data = await this.request<{ active?: boolean }>(
        'POST',
        '/internal/realtime/apply-text',
        { projectId, docId, text },
        this.timeoutMs,
      );
      return Boolean(data?.active);
    } catch (err: unknown) {
      this.logger.warn(
        `Realtime remote applyExternalText failed for ${projectId}:${docId}: ${this.errorMessage(err)}`,
      );
      return false;
    }
  }

  public async evictDoc(projectId: string, docId: string): Promise<void> {
    if (!this.remoteEnabled || !projectId || !docId) {
      return;
    }

    try {
      await this.request<{ evicted?: boolean }>(
        'POST',
        '/internal/realtime/evict-doc',
        { projectId, docId },
        this.timeoutMs,
      );
    } catch (err: unknown) {
      this.logger.warn(
        `Realtime remote evictDoc failed for ${projectId}:${docId}: ${this.errorMessage(err)}`,
      );
    }
  }

  public async getPresence(
    projectId: string,
    docId: string | null,
  ): Promise<LivePresenceUser[]> {
    if (!this.remoteEnabled || !projectId) {
      return [];
    }

    const params = new URLSearchParams({ projectId });
    if (docId) {
      params.set('docId', docId);
    }

    try {
      const data = await this.request<{ users?: LivePresenceUser[] }>(
        'GET',
        `/internal/realtime/presence?${params.toString()}`,
        undefined,
        this.timeoutMs,
      );
      return Array.isArray(data?.users) ? data.users : [];
    } catch (err: unknown) {
      this.logger.warn(
        `Realtime remote getPresence failed for project ${projectId}: ${this.errorMessage(err)}`,
      );
      return [];
    }
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    timer.unref?.();

    const headers: Record<string, string> = {};
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    if (this.internalKey) {
      headers[REALTIME_INTERNAL_KEY_HEADER] = this.internalKey;
    }

    try {
      const response = await this.fetchFn(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      return (await response.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  private errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}
