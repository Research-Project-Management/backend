/**
 * modules/manuscripts/clsi/services/remote-clsi.client.ts
 *
 * Canonical Remote CLSI Microservice Client Adapter.
 * Communicates with the dedicated `flux-clsi` container over a single canonical HTTP contract:
 *  - POST ${CLSI_URL}/compile
 *  - POST ${CLSI_URL}/synctex/forward
 *  - POST ${CLSI_URL}/synctex/reverse
 *  - GET  ${CLSI_URL}/status
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisCacheService } from '@/core';
import { CompilePipelineResult, ClsiHealthReport } from './compile-pipeline.service';
import { CompileManuscriptDto } from '../dto/clsi.dto';
import { ForwardSyncDto, ReverseSyncDto } from '../dto/synctex.dto';
import { SyncPoint, ReverseSyncPoint } from '../domain/clsi.ports';

export interface RemoteCompileRequest {
  projectId: string;
  mainFile: string;
  source: string;
  mergedFiles: Record<string, string | Buffer>;
  dto: CompileManuscriptDto;
  engine?: string;
  cacheKey: string;
  signal?: AbortSignal;
}

@Injectable()
export class RemoteClsiClientAdapter {
  private readonly logger = new Logger(RemoteClsiClientAdapter.name);
  private remoteClsiBackoffUntil = 0;

  constructor(
    @Optional() private readonly configService?: ConfigService,
    @Optional() private readonly cache?: RedisCacheService,
  ) {}

  private getRemoteUrl(): string | null {
    const raw = (
      this.configService?.get<string>('CLSI_URL') ||
      process.env.CLSI_URL ||
      ''
    )
      .trim()
      .replace(/\/+$/, '');
    return raw || null;
  }

  public isEnabled(): boolean {
    return Boolean(this.getRemoteUrl());
  }

  private async runWithRemoteCircuitBreaker<T>(
    action: (baseUrl: string) => Promise<T | null>,
    options: { bypassBackoff?: boolean } = {},
  ): Promise<T | null> {
    const baseUrl = this.getRemoteUrl();
    if (!baseUrl) {
      return null;
    }

    if (!options.bypassBackoff && Date.now() < this.remoteClsiBackoffUntil) {
      return null;
    }

    try {
      const result = await action(baseUrl);
      if (result !== null) {
        this.remoteClsiBackoffUntil = 0;
        return result;
      }
    } catch (err: unknown) {
      if ((err as { name?: string })?.name === 'AbortError') {
        throw err;
      }
      this.logger.warn(
        `Remote CLSI (${baseUrl}) unreachable: ${(err as Error)?.message}`,
      );
    }

    if (!options.bypassBackoff) {
      this.remoteClsiBackoffUntil = Date.now() + 10_000;
    }
    return null;
  }

  private async postRemoteJson<TResponse>(
    endpoint: string,
    payload: Record<string, unknown>,
    options: { timeoutMs?: number; bypassBackoff?: boolean; signal?: AbortSignal } = {},
  ): Promise<TResponse | null> {
    return this.runWithRemoteCircuitBreaker(
      async (baseUrl) => {
        const timeoutMs = options.timeoutMs ?? 8000;
        const timeoutSignal = AbortSignal.timeout(timeoutMs);
        const combinedSignal = options.signal
          ? AbortSignal.any([options.signal, timeoutSignal])
          : timeoutSignal;

        const res = await fetch(`${baseUrl}${endpoint}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: combinedSignal,
        });

        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        return (await res.json()) as TResponse;
      },
      options,
    );
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
      projectId,
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
        ? val.toString('base64')
        : String(val);
    }

    const result = await this.postRemoteJson<CompilePipelineResult>(
      '/compile',
      {
        projectId,
        mainFile,
        source,
        engine: engine || dto.engine || 'pdflatex',
        texLiveVersion: dto.texLiveVersion || '2025',
        draft: dto.draft ?? false,
        syntaxOnly: dto.syntaxOnly ?? false,
        forceClean: dto.forceClean ?? false,
        stopOnFirstError: dto.stopOnFirstError ?? false,
        timeoutMs: effectiveTimeoutMs,
        files: filesPayload,
      },
      {
        timeoutMs: effectiveTimeoutMs + 5000,
        signal,
      },
    );

    return result ?? null;
  }

  public async tryRemoteForwardSync(dto: ForwardSyncDto): Promise<{
    success: boolean;
    result?: SyncPoint;
    error?: string;
  } | null> {
    const data = await this.postRemoteJson<{
      success?: boolean;
      result?: SyncPoint;
      error?: string;
    }>('/synctex/forward', {
      projectId: dto.projectId,
      pageId: dto.pageId,
      file: dto.file,
      line: dto.line,
      column: dto.column,
      synctex: dto.synctex,
    });

    if (data && typeof data.success === 'boolean') {
      return {
        success: data.success,
        result: data.result,
        error: data.error,
      };
    }
    return null;
  }

  public async tryRemoteReverseSync(dto: ReverseSyncDto): Promise<{
    success: boolean;
    result?: ReverseSyncPoint;
    error?: string;
  } | null> {
    const data = await this.postRemoteJson<{
      success?: boolean;
      result?: ReverseSyncPoint;
      error?: string;
    }>('/synctex/reverse', {
      projectId: dto.projectId,
      pageId: dto.pageId,
      page: dto.page,
      x: dto.x,
      y: dto.y,
      synctex: dto.synctex,
    });

    if (data && typeof data.success === 'boolean') {
      return {
        success: data.success,
        result: data.result,
        error: data.error,
      };
    }
    return null;
  }
}
