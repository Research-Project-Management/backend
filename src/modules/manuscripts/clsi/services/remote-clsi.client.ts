/**
 * modules/manuscripts/clsi/services/remote-clsi.client.ts
 * Client encapsulating HTTP delegation to an external/remote Overleaf CLSI microservice.
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisCacheService, CircuitBreaker } from '@/core';
import { CompileManuscriptDto } from '../dto/clsi.dto';
import { ForwardSyncDto, ReverseSyncDto } from '../dto/synctex.dto';
import { SyncPoint, ReverseSyncPoint } from '../domain';
import { CompileLogAnalyzer } from '@/modules/manuscripts/diagnostics/domain';
import { CompilePipelineResult } from './compile-pipeline.service';

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
  private readonly remoteClsiUrl: string;
  private readonly remoteClsiUrls: string[];
  private readonly logParser = new CompileLogAnalyzer();
  private readonly circuitBreaker = new CircuitBreaker({
    name: 'RemoteCLSI',
    failureThreshold: 3,
    cooldownMs: 25000,
  });

  constructor(
    @Optional() private readonly configService?: ConfigService,
    @Optional() private readonly cache?: RedisCacheService,
  ) {
    const rawConfigured =
      this.configService?.get<string>('CLSI_REMOTE_URL') ||
      this.configService?.get<string>('CLSI_URL') ||
      process.env.CLSI_REMOTE_URL ||
      process.env.CLSI_URL ||
      '';
    this.remoteClsiUrls = rawConfigured
      .split(',')
      .map((u) =>
        u
          .trim()
          .replace(/^['"]+|['"]+$/g, '')
          .replace(/\/+$/, ''),
      )
      .filter(Boolean);
    this.remoteClsiUrl = this.remoteClsiUrls[0] || '';
  }

  public isEnabled(): boolean {
    return this.remoteClsiUrls.length > 0;
  }

  /**
   * Circuit-Breaker Decorator / Template wrapper for remote CLSI HTTP operations.
   * Ensures accurate operation-scoped logging and consistent failure recording.
   */
  private async guarded<T>(
    operationName: string,
    fn: (baseUrl: string) => Promise<T | null>,
  ): Promise<T | null> {
    if (this.remoteClsiUrls.length === 0) return null;
    if (this.circuitBreaker.isOpen()) {
      this.logger.warn(
        `Remote CLSI Circuit Breaker is OPEN. Fast-failing ${operationName} request to local pipeline.`,
      );
      return null;
    }
    let lastErr: unknown = null;
    for (const candidateUrl of this.remoteClsiUrls) {
      try {
        const baseUrl = candidateUrl.replace(/\/+$/, '');
        const res = await fn(baseUrl);
        if (res !== null) {
          return res;
        }
      } catch (err: unknown) {
        lastErr = err;
        const cause = (err as { cause?: { code?: string; message?: string } })
          ?.cause;
        const causeDetail = cause
          ? ` (${cause.code || ''} ${cause.message || ''})`.trim()
          : '';
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `Remote CLSI ${operationName} candidate ${candidateUrl} failed: ${msg} ${causeDetail}`.trim(),
        );
      }
    }
    if (lastErr) {
      this.circuitBreaker.recordFailure(lastErr);
      const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
      this.logger.warn(
        `Remote CLSI ${operationName} failed across all candidates: ${msg}. Falling back to local pipeline.`,
      );
    }
    return null;
  }

  private resolveUrl(baseUrl: string, targetUrl: string): string {
    const normalizedBase = baseUrl.replace(/\/+$/, '');
    if (targetUrl.startsWith('http://') || targetUrl.startsWith('https://')) {
      try {
        const parsedBase = new URL(normalizedBase);
        const parsedTarget = new URL(targetUrl);
        if (parsedTarget.origin !== parsedBase.origin) {
          throw new Error('Cross-origin CLSI artifact URL rejected');
        }
        return targetUrl;
      } catch {
        throw new Error('Invalid remote CLSI target URL');
      }
    }
    const normalizedTarget = targetUrl.startsWith('/')
      ? targetUrl
      : `/${targetUrl}`;
    return `${normalizedBase}${normalizedTarget}`;
  }

  public async fetchRemoteText(
    baseUrl: string,
    targetUrl?: string,
  ): Promise<string> {
    if (!targetUrl) return '';
    try {
      const fullUrl = this.resolveUrl(baseUrl, targetUrl);
      const res = await fetch(fullUrl);
      if (res.ok) {
        return await res.text();
      }
    } catch {
      /* ignore artifact fetch errors */
    }
    return '';
  }

  public async fetchRemoteBuffer(
    baseUrl: string,
    targetUrl?: string,
  ): Promise<string> {
    if (!targetUrl) return '';
    try {
      const fullUrl = this.resolveUrl(baseUrl, targetUrl);
      const res = await fetch(fullUrl);
      if (res.ok) {
        const buf = await res.arrayBuffer();
        return Buffer.from(buf).toString('base64');
      }
    } catch {
      /* ignore artifact fetch errors */
    }
    return '';
  }

  public async tryRemoteClsiCompile(
    projectIdOrRequest: string | RemoteCompileRequest,
    mainFileArg?: string,
    sourceArg?: string,
    mergedFilesArg?: Record<string, string | Buffer>,
    dtoArg?: CompileManuscriptDto,
    engineArg?: string,
    cacheKeyArg?: string,
    signalArg?: AbortSignal,
  ): Promise<CompilePipelineResult | null> {
    const req: RemoteCompileRequest =
      typeof projectIdOrRequest === 'object'
        ? projectIdOrRequest
        : {
            projectId: projectIdOrRequest,
            mainFile: mainFileArg!,
            source: sourceArg!,
            mergedFiles: mergedFilesArg!,
            dto: dtoArg!,
            engine: engineArg,
            cacheKey: cacheKeyArg!,
            signal: signalArg,
          };

    return this.guarded<CompilePipelineResult>('compile', async (baseUrl) => {
      const {
        projectId,
        mainFile,
        source,
        mergedFiles,
        dto,
        engine,
        cacheKey,
        signal,
      } = req;
      const endpoints = baseUrl.endsWith('/api/clsi')
        ? [`${baseUrl}/compile`]
        : [
            `${baseUrl}/api/clsi/compile`,
            `${baseUrl}/project/${encodeURIComponent(projectId)}/compile`,
            `${baseUrl}/compile`,
          ];

      const serializedFiles: Record<string, string> = {};
      for (const [k, v] of Object.entries(mergedFiles)) {
        if (Buffer.isBuffer(v)) {
          serializedFiles[k] = `base64:${v.toString('base64')}`;
        } else {
          serializedFiles[k] = v;
        }
      }

      let response: Response | null = null;
      let lastError: Error | null = null;
      const timeoutSignal = AbortSignal.timeout(
        dto.timeout_ms ?? dto.timeoutMs ?? 60000,
      );
      const requestSignal =
        signal && typeof AbortSignal.any === 'function'
          ? AbortSignal.any([signal, timeoutSignal])
          : signal || timeoutSignal;

      for (const endpoint of endpoints) {
        if (signal?.aborted) {
          return null;
        }
        try {
          const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ...dto,
              projectId,
              project_id: projectId,
              mainFile,
              main_file: mainFile,
              source,
              files: serializedFiles,
              engine,
            }),
            signal: requestSignal,
          });
          if (res.status !== 404) {
            response = res;
            break;
          }
        } catch (err: unknown) {
          lastError = err instanceof Error ? err : new Error(String(err));
        }
      }

      if (response && response.ok) {
        const rawResult = await response.json();
        let result: CompilePipelineResult;

        if (rawResult?.compile?.status) {
          const isSuccess = rawResult.compile.status === 'success';
          const outputFiles: Array<{
            type?: string;
            path?: string;
            url?: string;
            content?: string;
          }> = rawResult.compile.outputFiles || [];
          const pdfEntry = outputFiles.find(
            (f) => f.type === 'pdf' || f.path === 'output.pdf',
          );
          const logEntry = outputFiles.find(
            (f) => f.type === 'log' || f.path === 'output.log',
          );
          const synctexEntry = outputFiles.find(
            (f) =>
              f.type === 'synctex.gz' ||
              f.type === 'synctex' ||
              f.path?.includes('synctex'),
          );

          const [pdfBase64, logsText, synctexBase64] = await Promise.all([
            typeof rawResult.pdf === 'string' && rawResult.pdf.length > 0
              ? Promise.resolve(rawResult.pdf)
              : this.fetchRemoteBuffer(baseUrl, pdfEntry?.url),
            typeof rawResult.logs === 'string' && rawResult.logs.length > 0
              ? Promise.resolve(rawResult.logs)
              : this.fetchRemoteText(baseUrl, logEntry?.url),
            typeof rawResult.synctex === 'string' &&
            rawResult.synctex.length > 0
              ? Promise.resolve(rawResult.synctex)
              : this.fetchRemoteBuffer(baseUrl, synctexEntry?.url),
          ]);

          const diagnostics =
            Array.isArray(rawResult.diagnostics) &&
            rawResult.diagnostics.length > 0
              ? rawResult.diagnostics
              : this.logParser.parse(logsText, mainFile);
          const durationMs =
            rawResult.durationMs ?? rawResult.timing?.totalMs ?? 0;

          if (isSuccess && pdfBase64) {
            result = {
              success: true,
              status: 'success',
              compile: rawResult.compile,
              pdf: pdfBase64,
              synctex: synctexBase64 || undefined,
              logs: logsText,
              diagnostics: diagnostics.length > 0 ? diagnostics : undefined,
              outputFiles: rawResult.outputFiles,
              durationMs,
            };
          } else {
            result = {
              success: false,
              status: 'failure',
              compile: rawResult.compile,
              error:
                rawResult.error ||
                diagnostics.find(
                  (d: { severity?: string; message?: string }) =>
                    d.severity === 'error',
                )?.message ||
                'LaTeX compilation failed to produce a PDF',
              pdf: pdfBase64 || undefined,
              synctex: synctexBase64 || undefined,
              logs: logsText,
              diagnostics: diagnostics.length > 0 ? diagnostics : undefined,
              outputFiles: rawResult.outputFiles,
              durationMs,
            };
          }
        } else {
          const isSuccess = Boolean(
            rawResult.success || rawResult.status === 'success',
          );
          const logsText =
            typeof rawResult.logs === 'string' ? rawResult.logs : '';
          const diagnostics =
            Array.isArray(rawResult.diagnostics) &&
            rawResult.diagnostics.length > 0
              ? rawResult.diagnostics
              : logsText
                ? this.logParser.parse(logsText, mainFile)
                : undefined;
          result = {
            ...rawResult,
            success: isSuccess,
            status: isSuccess ? 'success' : 'failure',
            compile: rawResult.compile ?? {
              status: isSuccess ? 'success' : 'failure',
              outputFiles: [],
            },
            diagnostics:
              diagnostics && diagnostics.length > 0 ? diagnostics : undefined,
            durationMs: rawResult.durationMs ?? rawResult.timing?.totalMs ?? 0,
          };
        }

        if (
          result.success &&
          this.cache &&
          result.pdf &&
          result.pdf.length <= 2 * 1024 * 1024
        ) {
          await this.cache.set(cacheKey, result, 300);
        }
        this.circuitBreaker.recordSuccess();
        return result;
      }

      if (response) {
        throw new Error(`HTTP ${response.status}`);
      }
      if (lastError) {
        throw lastError;
      }
      return null;
    });
  }

  public async tryRemoteHealthCheck(): Promise<Record<string, unknown> | null> {
    return this.guarded('healthCheck', async (baseUrl) => {
      const response = await fetch(`${baseUrl}/status`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok) {
        this.circuitBreaker.recordSuccess();
        return (await response.json()) as Record<string, unknown>;
      }
      throw new Error(`HTTP ${response.status}`);
    });
  }

  public async tryRemoteForwardSync(dto: ForwardSyncDto): Promise<{
    success: boolean;
    result?: SyncPoint;
    error?: string;
  } | null> {
    return this.guarded('forwardSync', async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/clsi/synctex/forward`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dto),
        signal: AbortSignal.timeout(10000),
      });
      if (response.ok) {
        this.circuitBreaker.recordSuccess();
        return await response.json();
      }
      this.circuitBreaker.recordFailure(new Error(`HTTP ${response.status}`));
      return null;
    });
  }

  public async tryRemoteReverseSync(dto: ReverseSyncDto): Promise<{
    success: boolean;
    result?: ReverseSyncPoint;
    error?: string;
  } | null> {
    return this.guarded('reverseSync', async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/clsi/synctex/reverse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dto),
        signal: AbortSignal.timeout(10000),
      });
      if (response.ok) {
        this.circuitBreaker.recordSuccess();
        return await response.json();
      }
      this.circuitBreaker.recordFailure(new Error(`HTTP ${response.status}`));
      return null;
    });
  }
}
