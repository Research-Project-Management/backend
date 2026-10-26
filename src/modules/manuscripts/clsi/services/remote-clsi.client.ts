/**
 * modules/manuscripts/clsi/services/remote-clsi.client.ts
 * Client encapsulating HTTP delegation to an external/remote Overleaf CLSI microservice.
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisCacheService, CircuitBreaker } from '@/core';
import { CompileManuscriptDto } from '../dto/clsi.dto';
import { ForwardSyncDto, ReverseSyncDto } from '../dto/synctex.dto';
import { SyncPoint, ReverseSyncPoint } from '../domain/clsi-ports';
import { CompileLogAnalyzer } from '@/modules/manuscripts/diagnostics/domain';
import { CompilePipelineResult } from './compile-pipeline.service';

@Injectable()
export class RemoteClsiClientAdapter {
  private readonly logger = new Logger(RemoteClsiClientAdapter.name);
  private readonly remoteClsiUrl: string;
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
    this.remoteClsiUrl =
      this.configService?.get<string>('CLSI_REMOTE_URL') ||
      this.configService?.get<string>('CLSI_URL') ||
      '';
  }

  public isEnabled(): boolean {
    return Boolean(this.remoteClsiUrl);
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
    projectId: string,
    mainFile: string,
    source: string,
    mergedFiles: Record<string, string | Buffer>,
    dto: CompileManuscriptDto,
    engine: string | undefined,
    cacheKey: string,
  ): Promise<CompilePipelineResult | null> {
    if (!this.remoteClsiUrl) return null;
    if (this.circuitBreaker.isOpen()) {
      this.logger.warn(
        `Remote CLSI Circuit Breaker is OPEN. Fast-failing compile request to local pipeline.`,
      );
      return null;
    }

    try {
      const baseUrl = this.remoteClsiUrl.replace(/\/+$/, '');
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
          const isBinaryAsset =
            /\.(png|jpe?g|gif|webp|pdf|eps|ps|ttf|otf|woff2?)$/i.test(k);
          serializedFiles[k] = isBinaryAsset
            ? `base64:${v.toString('base64')}`
            : v.toString('utf8');
        } else {
          serializedFiles[k] = v;
        }
      }

      let response: Response | null = null;
      let lastError: Error | null = null;

      for (const endpoint of endpoints) {
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
            signal: AbortSignal.timeout(
              dto.timeout_ms ?? dto.timeoutMs ?? 60000,
            ),
          });
          if (res.status !== 404) {
            response = res;
            break;
          }
        } catch (err: unknown) {
          this.circuitBreaker.recordFailure(err);
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
            this.fetchRemoteBuffer(baseUrl, pdfEntry?.url),
            this.fetchRemoteText(baseUrl, logEntry?.url),
            this.fetchRemoteBuffer(baseUrl, synctexEntry?.url),
          ]);

          const diagnostics = this.logParser.parse(logsText, mainFile);
          const durationMs = rawResult.timing?.totalMs ?? 0;

          if (isSuccess && pdfBase64) {
            result = {
              success: true,
              status: 'success',
              compile: rawResult.compile,
              pdf: pdfBase64,
              synctex: synctexBase64 || undefined,
              logs: logsText,
              diagnostics: diagnostics.length > 0 ? diagnostics : undefined,
              durationMs,
            };
          } else {
            result = {
              success: false,
              status: 'failure',
              compile: rawResult.compile,
              error:
                diagnostics.find(
                  (d: { severity?: string; message?: string }) =>
                    d.severity === 'error',
                )?.message || 'LaTeX compilation failed to produce a PDF',
              pdf: pdfBase64 || undefined,
              synctex: synctexBase64 || undefined,
              logs: logsText,
              diagnostics: diagnostics.length > 0 ? diagnostics : undefined,
              durationMs,
            };
          }
        } else {
          result = {
            ...rawResult,
            status:
              rawResult.status || (rawResult.success ? 'success' : 'failure'),
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
        this.circuitBreaker.recordFailure(new Error(`HTTP ${response.status}`));
        this.logger.warn(
          `Remote CLSI responded with HTTP ${response.status}. Falling back to local pipeline.`,
        );
      } else if (lastError) {
        this.circuitBreaker.recordFailure(lastError);
        this.logger.warn(
          `Remote CLSI compile failed: ${lastError.message}. Falling back to local pipeline.`,
        );
      }
    } catch (err: unknown) {
      this.circuitBreaker.recordFailure(err);
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Remote CLSI compile failed: ${msg}. Falling back to local pipeline.`,
      );
    }
    return null;
  }

  public async tryRemoteForwardSync(dto: ForwardSyncDto): Promise<{
    success: boolean;
    result?: SyncPoint;
    error?: string;
  } | null> {
    if (!this.remoteClsiUrl) return null;
    if (this.circuitBreaker.isOpen()) {
      this.logger.warn(
        `Remote CLSI Circuit Breaker is OPEN. Fast-failing compile request to local pipeline.`,
      );
      return null;
    }
    try {
      const baseUrl = this.remoteClsiUrl.replace(/\/+$/, '');
      const response = await fetch(`${baseUrl}/api/clsi/synctex/forward`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dto),
        signal: AbortSignal.timeout(10000),
      });
      if (response.ok) {
        return await response.json();
      }
    } catch (err: unknown) {
      this.circuitBreaker.recordFailure(err);
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Remote CLSI forwardSync failed: ${msg}. Falling back to local.`,
      );
    }
    return null;
  }

  public async tryRemoteReverseSync(dto: ReverseSyncDto): Promise<{
    success: boolean;
    result?: ReverseSyncPoint;
    error?: string;
  } | null> {
    if (!this.remoteClsiUrl) return null;
    if (this.circuitBreaker.isOpen()) {
      this.logger.warn(
        `Remote CLSI Circuit Breaker is OPEN. Fast-failing compile request to local pipeline.`,
      );
      return null;
    }
    try {
      const baseUrl = this.remoteClsiUrl.replace(/\/+$/, '');
      const response = await fetch(`${baseUrl}/api/clsi/synctex/reverse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dto),
        signal: AbortSignal.timeout(10000),
      });
      if (response.ok) {
        return await response.json();
      }
    } catch (err: unknown) {
      this.circuitBreaker.recordFailure(err);
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Remote CLSI reverseSync failed: ${msg}. Falling back to local.`,
      );
    }
    return null;
  }
}
