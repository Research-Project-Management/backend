/**
 * modules/pages/clsi/adapters/remote-clsi.adapter.ts
 *
 * Canonical Remote CLSI Microservice Client Adapter.
 * Communicates with the dedicated `flux-clsi` container over a single canonical HTTP contract:
 *  - POST ${CLSI_URL}/compile
 *  - POST ${CLSI_URL}/synctex/forward
 *  - POST ${CLSI_URL}/synctex/reverse
 *  - GET  ${CLSI_URL}/status
 */

import { randomUUID } from 'node:crypto';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CompilePipelineResult } from '../services/compile.service';
import type { ClsiHealthReport } from './health.adapter';
import { CompilePageDto } from '../dto/compile.dto';
import { ForwardSyncDto, ReverseSyncDto } from '../dto/synctex.dto';
import { AuxFileInfo, SyncPoint, ReverseSyncPoint } from '../domain/ports';
import { RemoteClsiClientError } from '../domain/errors';

export interface RemoteCompileRequest {
  spaceId: string;
  pageId?: string;
  mainFile: string;
  source: string;
  mergedFiles: Record<string, string | Buffer>;
  dto: CompilePageDto;
  engine?: string;
  cacheKey: string;
  signal?: AbortSignal;
}

type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

interface NodeCircuitState {
  state: CircuitState;
  consecutiveFailures: number;
  openUntil: number;
  halfOpenProbeInFlight: boolean;
}

@Injectable()
export class RemoteClsiClientAdapter {
  private readonly logger = new Logger(RemoteClsiClientAdapter.name);
  private readonly circuits = new Map<string, NodeCircuitState>();

  private static readonly FAILURE_THRESHOLD = 2;
  private static readonly BASE_BACKOFF_MS = 5_000;
  private static readonly MAX_BACKOFF_MS = 60_000;

  constructor(@Optional() private readonly configService?: ConfigService) {}

  private getOrCreateCircuit(baseUrl: string): NodeCircuitState {
    let circuit = this.circuits.get(baseUrl);
    if (!circuit) {
      circuit = {
        state: 'CLOSED',
        consecutiveFailures: 0,
        openUntil: 0,
        halfOpenProbeInFlight: false,
      };
      this.circuits.set(baseUrl, circuit);
    }
    return circuit;
  }

  private getRemoteUrls(): string[] {
    const rawList = (
      this.configService?.get<string>('CLSI_URLS') ||
      process.env.CLSI_URLS ||
      ''
    ).trim();
    if (rawList) {
      const urls = rawList
        .split(',')
        .map((u) => u.trim().replace(/\/+$/, ''))
        .filter(Boolean);
      if (urls.length > 0) return urls;
    }
    const single = (
      this.configService?.get<string>('CLSI_URL') ||
      process.env.CLSI_URL ||
      ''
    )
      .trim()
      .replace(/\/+$/, '');
    return single ? [single] : [];
  }

  /**
   * Deterministic FNV-1a sticky ordering: primary replica first, followed by
   * remaining replicas in ring order for automatic failover when primary is OPEN.
   */
  private orderCandidateUrls(routingKey?: string): string[] {
    const urls = this.getRemoteUrls();
    if (urls.length <= 1 || !routingKey) return urls;

    let hash = 0x811c9dc5;
    for (let i = 0; i < routingKey.length; i++) {
      hash ^= routingKey.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    const startIdx = (hash >>> 0) % urls.length;
    return [...urls.slice(startIdx), ...urls.slice(0, startIdx)];
  }

  public getBaseUrl(routingKey?: string): string | null {
    return this.orderCandidateUrls(routingKey)[0] ?? null;
  }

  public isEnabled(): boolean {
    return this.getRemoteUrls().length > 0;
  }

  private async runWithRemoteCircuitBreaker<T>(
    action: (baseUrl: string) => Promise<T | null>,
    options: {
      bypassBackoff?: boolean;
      signal?: AbortSignal;
      routingKey?: string;
    } = {},
  ): Promise<T | null> {
    const candidates = this.orderCandidateUrls(options.routingKey);
    if (candidates.length === 0) {
      return null;
    }

    for (const baseUrl of candidates) {
      const circuit = this.getOrCreateCircuit(baseUrl);
      let isHalfOpenProbe = false;

      if (!options.bypassBackoff) {
        if (circuit.state === 'OPEN') {
          if (Date.now() < circuit.openUntil) {
            continue;
          }
          // Cooldown expired: transition to HALF_OPEN and allow exactly 1 probe
          circuit.state = 'HALF_OPEN';
          circuit.halfOpenProbeInFlight = false;
        }

        if (circuit.state === 'HALF_OPEN') {
          if (circuit.halfOpenProbeInFlight) {
            continue;
          }
          circuit.halfOpenProbeInFlight = true;
          isHalfOpenProbe = true;
        }
      }

      try {
        const result = await action(baseUrl);
        if (result !== null) {
          circuit.state = 'CLOSED';
          circuit.consecutiveFailures = 0;
          circuit.openUntil = 0;
          return result;
        }
        return null;
      } catch (err: unknown) {
        if (
          (err as { name?: string })?.name === 'AbortError' ||
          options.signal?.aborted ||
          err instanceof RemoteClsiClientError
        ) {
          throw err;
        }
        this.logger.warn(
          `Remote CLSI (${baseUrl}) unreachable: ${(err as Error)?.message}`,
        );
        if (!options.bypassBackoff) {
          circuit.consecutiveFailures++;
          if (
            isHalfOpenProbe ||
            circuit.consecutiveFailures >=
              RemoteClsiClientAdapter.FAILURE_THRESHOLD
          ) {
            const exponent = Math.max(
              0,
              circuit.consecutiveFailures -
                RemoteClsiClientAdapter.FAILURE_THRESHOLD,
            );
            const backoffMs = Math.min(
              RemoteClsiClientAdapter.BASE_BACKOFF_MS * Math.pow(2, exponent),
              RemoteClsiClientAdapter.MAX_BACKOFF_MS,
            );
            circuit.state = 'OPEN';
            circuit.openUntil = Date.now() + backoffMs;
          }
        }
        // Fail over to next healthy replica if available
      } finally {
        if (isHalfOpenProbe) {
          circuit.halfOpenProbeInFlight = false;
        }
      }
    }

    return null;
  }

  private async postRemoteJson<TResponse>(
    endpoint: string,
    payload: Record<string, unknown>,
    options: {
      timeoutMs?: number;
      bypassBackoff?: boolean;
      propagateClientErrors?: boolean;
      signal?: AbortSignal;
      routingKey?: string;
    } = {},
  ): Promise<TResponse | null> {
    return this.runWithRemoteCircuitBreaker(async (baseUrl) => {
      const timeoutMs = options.timeoutMs ?? 8000;
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const combinedSignal = options.signal
        ? AbortSignal.any([options.signal, timeoutSignal])
        : timeoutSignal;

      const res = await fetch(`${baseUrl}${endpoint}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Request-Id': randomUUID(),
        },
        body: JSON.stringify(payload),
        signal: combinedSignal,
      });

      if (!res.ok) {
        let parsedBody: Record<string, unknown> | null = null;
        try {
          parsedBody = (await res.json()) as Record<string, unknown>;
        } catch {
          parsedBody = null;
        }
        const errorObj =
          parsedBody &&
          typeof parsedBody.error === 'object' &&
          parsedBody.error !== null
            ? (parsedBody.error as Record<string, unknown>)
            : null;
        const remoteCode =
          typeof errorObj?.code === 'string'
            ? errorObj.code
            : typeof parsedBody?.code === 'string'
              ? parsedBody.code
              : undefined;
        const remoteMessage =
          typeof errorObj?.message === 'string'
            ? errorObj.message
            : typeof parsedBody?.message === 'string'
              ? parsedBody.message
              : `Remote CLSI failed with HTTP ${res.status}`;
        const remoteDetails =
          errorObj?.details !== undefined
            ? errorObj.details
            : parsedBody?.details;
        const isStructuredBackpressure =
          res.status === 503 &&
          (remoteCode === 'COMPILE_QUEUE_FULL' ||
            remoteCode === 'COMPILE_QUEUE_TIMEOUT');

        if (
          (res.status >= 400 && res.status < 500) ||
          isStructuredBackpressure
        ) {
          if (options.propagateClientErrors) {
            throw new RemoteClsiClientError(
              remoteMessage,
              res.status,
              remoteCode || 'REMOTE_CLSI_CLIENT_ERROR',
              remoteDetails,
            );
          }
          return null;
        }

        throw new Error(`HTTP ${res.status}`);
      }
      return (await res.json()) as TResponse;
    }, options);
  }

  public async tryRemoteHealthCheck(): Promise<ClsiHealthReport | null> {
    return this.runWithRemoteCircuitBreaker(
      async (baseUrl) => {
        const res = await fetch(`${baseUrl}/status`, {
          method: 'GET',
          signal: AbortSignal.timeout(4000),
        });
        if (!res.ok) return null;
        const data = (await res.json()) as Partial<ClsiHealthReport>;
        if (data && data.status && data.compilers) {
          return data as ClsiHealthReport;
        }
        return null;
      },
      { bypassBackoff: true },
    );
  }

  public async tryRemoteClsiCompile(
    request: RemoteCompileRequest,
  ): Promise<CompilePipelineResult | null> {
    const {
      spaceId,
      pageId,
      mainFile,
      source,
      mergedFiles,
      dto,
      engine,
      signal,
    } = request;

    const effectiveTimeoutMs = Math.min(
      Math.max(dto.timeoutMs ?? 240000, 5000),
      600000,
    );

    const filesPayload: Record<string, string> = {};
    for (const [filePath, val] of Object.entries(mergedFiles)) {
      filesPayload[filePath] = Buffer.isBuffer(val)
        ? `base64:${val.toString('base64')}`
        : String(val);
    }

    const routingKey = pageId || dto.pageId || spaceId || dto.spaceId;
    const result = await this.postRemoteJson<CompilePipelineResult>(
      '/compile',
      {
        spaceId: spaceId || dto.spaceId,
        pageId: pageId || dto.pageId || spaceId,
        mainFile,
        source,
        ...(engine || dto.engine ? { engine: engine || dto.engine } : {}),
        texLiveVersion: dto.texLiveVersion || '2025',
        draft: dto.draft ?? false,
        syntaxOnly: dto.syntaxOnly ?? false,
        forceClean: dto.forceClean ?? false,
        stopOnFirstError: dto.stopOnFirstError ?? false,
        priority: dto.priority ?? 'manual',
        timeoutMs: effectiveTimeoutMs,
        files: filesPayload,
      },
      {
        timeoutMs: effectiveTimeoutMs + 5000,
        propagateClientErrors: true,
        signal,
        routingKey,
      },
    );

    return result ?? null;
  }

  public async tryRemoteForwardSync(
    dto: ForwardSyncDto,
    resolvedContext?: { spaceId?: string; pageId?: string },
  ): Promise<{
    success: boolean;
    result?: SyncPoint;
    error?: string;
  } | null> {
    const routingKey =
      resolvedContext?.pageId ?? dto.pageId ?? resolvedContext?.spaceId ?? dto.spaceId;
    const data = await this.postRemoteJson<{
      success?: boolean;
      result?: SyncPoint;
      error?: string;
    }>(
      '/synctex/forward',
      {
        spaceId: resolvedContext?.spaceId ?? dto.spaceId,
        pageId: resolvedContext?.pageId ?? dto.pageId,
        file: dto.file,
        line: dto.line,
        column: dto.column,
        synctex: dto.synctex,
      },
      { routingKey },
    );

    if (data && typeof data.success === 'boolean') {
      return {
        success: data.success,
        result: data.result,
        error: data.error,
      };
    }
    return null;
  }

  public async tryRemoteReverseSync(
    dto: ReverseSyncDto,
    resolvedContext?: { spaceId?: string; pageId?: string },
  ): Promise<{
    success: boolean;
    result?: ReverseSyncPoint;
    error?: string;
  } | null> {
    const routingKey =
      resolvedContext?.pageId ?? dto.pageId ?? resolvedContext?.spaceId ?? dto.spaceId;
    const data = await this.postRemoteJson<{
      success?: boolean;
      result?: ReverseSyncPoint;
      error?: string;
    }>(
      '/synctex/reverse',
      {
        spaceId: resolvedContext?.spaceId ?? dto.spaceId,
        pageId: resolvedContext?.pageId ?? dto.pageId,
        page: dto.page,
        x: dto.x,
        y: dto.y,
        synctex: dto.synctex,
      },
      { routingKey },
    );

    if (data && typeof data.success === 'boolean') {
      return {
        success: data.success,
        result: data.result,
        error: data.error,
      };
    }
    return null;
  }

  public async tryRemoteDownloadArtifact(
    scratchId: string,
    filename: string,
  ): Promise<Buffer | null> {
    return this.runWithRemoteCircuitBreaker(
      async (baseUrl) => {
        const res = await fetch(
          `${baseUrl}/artifacts/${encodeURIComponent(scratchId)}/${encodeURIComponent(filename)}`,
          {
            method: 'GET',
            headers: { 'X-Request-Id': randomUUID() },
            signal: AbortSignal.timeout(15000),
          },
        );
        if (!res.ok) return null;
        const arr = await res.arrayBuffer();
        return Buffer.from(arr);
      },
      { routingKey: scratchId },
    );
  }

  public async tryRemoteListAuxFiles(
    scratchId: string,
  ): Promise<AuxFileInfo[] | null> {
    return this.runWithRemoteCircuitBreaker(
      async (baseUrl) => {
        const res = await fetch(
          `${baseUrl}/artifacts/${encodeURIComponent(scratchId)}`,
          {
            method: 'GET',
            headers: { 'X-Request-Id': randomUUID() },
            signal: AbortSignal.timeout(8000),
          },
        );
        if (!res.ok) return null;
        const data = (await res.json()) as { files?: AuxFileInfo[] };
        return Array.isArray(data.files) ? data.files : null;
      },
      { routingKey: scratchId },
    );
  }

  public async tryRemoteCleanScratch(scratchId: string): Promise<boolean> {
    const result = await this.runWithRemoteCircuitBreaker(
      async (baseUrl) => {
        const res = await fetch(
          `${baseUrl}/artifacts/${encodeURIComponent(scratchId)}`,
          {
            method: 'DELETE',
            headers: { 'X-Request-Id': randomUUID() },
            signal: AbortSignal.timeout(8000),
          },
        );
        return res.ok ? true : null;
      },
      { routingKey: scratchId },
    );
    return Boolean(result);
  }
}
