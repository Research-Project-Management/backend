/**
 * modules/pages/clsi/clsi.service.ts
 * Deep module orchestrating CLSI compile operations, caching, SyncTeX coordinate
 * resolution, and academic word counts.
 */

import {
  Injectable,
  Logger,
  HttpException,
  Optional,
  OnModuleDestroy,
} from '@nestjs/common';
import { FastifyReply } from 'fastify';
import * as crypto from 'crypto';
import { RedisCacheService } from '@/core';
import { PagesDomainError } from '@/modules/pages/core/domain/pages-domain.error';
import { PAGES_CACHE_KEYS } from '@/modules/pages/core/pages.cache-keys';
import { SnapshotService } from '@/modules/pages/history/services/snapshot.service';
import {
  CompilePageDto,
  ClsiWordCountDto,
} from './dto/compile.dto';
import { ForwardSyncDto, ReverseSyncDto } from './dto/synctex.dto';
import { WordCountStats } from './domain/ports';
import { ClsiRepository } from './clsi.repository';
import {
  DiskUsageCleaner,
  DiskUsageOptions,
} from './adapters/scratch-disk.adapter';
import {
  PlannedFileSet,
  validatePlannedFileSet,
} from './domain/file-set.planner';
import {
  CompileService,
  CompilePipelineResult,
  enrichUnreachableRemoteFailure,
} from './services/compile.service';
import { ClsiHealthCheck } from './adapters/health.adapter';
import { CompileLockService } from './services/compile-lock.service';
import { ClsiMetrics } from './adapters/metrics.adapter';
import { RealtimeFacade } from '@/modules/realtime/realtime.facade';
import { RemoteClsiClientAdapter } from './adapters/remote-clsi.adapter';
import { CompileSourceService } from './services/compile-source.service';
import { SynctexService } from './services/synctex.service';
import { WordCountService } from './services/wordcount.service';
import {
  type EditorLastBuildSummary,
  OutputService,
} from './services/output.service';

export type ClsiCompileResult = CompilePipelineResult;
export type { EditorLastBuildSummary };

@Injectable()
export class ClsiService implements OnModuleDestroy {
  private readonly logger = new Logger(ClsiService.name);
  private readonly lastAutoSnapshotTimes = new Map<string, number>();

  constructor(
    private readonly remoteClient: RemoteClsiClientAdapter,
    private readonly compileSource: CompileSourceService,
    private readonly workspace: ClsiRepository,
    private readonly diskUsageCleaner: DiskUsageCleaner,
    private readonly healthCheck: ClsiHealthCheck,
    private readonly pipeline: CompileService,
    private readonly compileLock: CompileLockService,
    private readonly metrics: ClsiMetrics,
    private readonly synctexService: SynctexService,
    private readonly wordCountService: WordCountService,
    private readonly outputService: OutputService,
    @Optional() private readonly cache?: RedisCacheService,
    @Optional() private readonly realtimeService?: RealtimeFacade,
    @Optional() private readonly snapshotService?: SnapshotService,
  ) {}

  public onModuleDestroy(): void {
    this.compileLock.onModuleDestroy();
  }

  private hashSource(source: string): string {
    return crypto
      .createHash('sha256')
      .update(source || '')
      .digest('hex');
  }

  public async compile(
    dto: CompilePageDto,
    userId?: string,
    authorizedSpaceId?: string,
  ): Promise<ClsiCompileResult> {
    const requestedEngine = dto.engine;
    const texLiveVersion = dto.texLiveVersion || '2025';
    const { spaceId: resolvedSpaceId, pageId: targetPageId } =
      await this.compileSource.resolvePageCompileContext(
        dto,
        authorizedSpaceId,
      );
    const effectiveSpaceId =
      resolvedSpaceId && resolvedSpaceId !== 'default'
        ? resolvedSpaceId
        : userId
          ? `adhoc-${userId}`
          : `adhoc-${crypto.randomUUID()}`;
    const scratchWorkspaceId = targetPageId || effectiveSpaceId;
    const effectiveTimeoutMs = dto.timeoutMs ?? 240000;
    const metricEngine = requestedEngine || 'pdflatex';

    return await this.compileLock.runWithLock(
      scratchWorkspaceId,
      userId,
      this.realtimeService,
      async (signal, onLogChunk) => {
        if (
          this.realtimeService &&
          effectiveSpaceId &&
          !effectiveSpaceId.startsWith('adhoc-')
        ) {
          try {
            await this.realtimeService.flushProjectBeforeCompile(
              effectiveSpaceId,
            );
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            this.logger.warn(
              `Pre-compile flush barrier encountered an error for space ${effectiveSpaceId}: ${msg}`,
            );
          }
        }

        const plan = await this.compileSource.planFiles(
          effectiveSpaceId.startsWith('adhoc-') ? 'default' : effectiveSpaceId,
          dto,
          targetPageId,
        );
        if (!effectiveSpaceId.startsWith('adhoc-') || plan.files.size > 0) {
          const validationIssues = validatePlannedFileSet(plan);
          if (validationIssues.length > 0) {
            return {
              success: false,
              status: 'failure',
              outcome: 'validation-problems',
              error: validationIssues[0].message,
              logs: '',
              diagnostics: [],
              validationIssues,
              durationMs: 0,
            };
          }
        }
        const cacheKey = PAGES_CACHE_KEYS.clsiCompile(
          this.hashSource(
            [
              effectiveSpaceId,
              scratchWorkspaceId,
              plan.fingerprint,
              plan.mainFile,
              requestedEngine || 'auto',
              texLiveVersion,
              dto.draft ?? false,
              dto.syntaxOnly ?? false,
              dto.stopOnFirstError ?? false,
            ].join('|'),
          ),
        );
        const cacheable = !!(
          dto.useCache &&
          !dto.forceClean &&
          plan.hasMainContent
        );

        if (cacheable && this.cache) {
          const cacheLookupStart = Date.now();
          const cached = await this.cache.get<ClsiCompileResult>(cacheKey);
          if (
            cached &&
            cached.success &&
            (cached.diagnosticsSummary?.totalErrors ?? 0) === 0
          ) {
            await this.outputService.syncCachedArtifactsToScratch(
              scratchWorkspaceId,
              cached,
            );
            this.metrics.record({
              engine: metricEngine,
              durationMs: Math.max(1, Date.now() - cacheLookupStart),
              success: true,
              isCached: true,
              isTimeout: false,
              pdfSizeBytes: cached.pdf
                ? Buffer.byteLength(cached.pdf, 'base64')
                : (cached.pdfSizeBytes ?? 0),
            });
            return await this.outputService.formatCompileResultForClient({
              result: cached,
              responseMode: dto.responseMode,
              spaceId: effectiveSpaceId,
              pageId: targetPageId,
              scratchWorkspaceId,
            });
          }
        }

        return await this.runScheduledCompile({
          spaceId: effectiveSpaceId,
          plan,
          dto,
          engine: requestedEngine,
          cacheKey,
          effectiveTimeoutMs,
          metricEngine,
          texLiveVersion,
          signal,
          onLogChunk,
          userId,
          scratchWorkspaceId,
          targetPageId,
        });
      },
      {
        priority: dto.priority ?? 'manual',
        ...(dto.forceClean ? { forceClean: true } : {}),
      },
    );
  }

  private async runScheduledCompile(params: {
    spaceId: string;
    plan: PlannedFileSet;
    dto: CompilePageDto;
    engine: string | undefined;
    cacheKey: string;
    effectiveTimeoutMs: number;
    metricEngine: string;
    texLiveVersion: string;
    signal: AbortSignal;
    onLogChunk: (chunk: string) => void;
    userId?: string;
    scratchWorkspaceId: string;
    targetPageId?: string;
  }): Promise<ClsiCompileResult> {
    const {
      spaceId,
      plan,
      dto,
      engine,
      cacheKey,
      effectiveTimeoutMs,
      metricEngine,
      texLiveVersion,
      signal,
      onLogChunk,
      userId,
      scratchWorkspaceId,
      targetPageId,
    } = params;
    const mainFile = plan.mainFile;
    const dbSpaceId = spaceId.startsWith('adhoc-') ? 'default' : spaceId;

    if (dto.forceClean) {
      await this.pipeline.runWithWorkspaceLock(
        scratchWorkspaceId,
        () => this.workspace.cleanScratch(scratchWorkspaceId),
        signal,
      );
    }

    const mergedFiles = await this.compileSource.hydrateFiles(
      dbSpaceId,
      plan,
      scratchWorkspaceId,
      {
        deltaOnlyOnDisk: !this.remoteClient.isEnabled() && !dto.forceClean,
      },
    );
    const rawMain = mergedFiles[mainFile] ?? dto.source ?? '';
    const source = Buffer.isBuffer(rawMain)
      ? rawMain.toString('utf8')
      : rawMain;

    const remoteResult = await this.remoteClient.tryRemoteClsiCompile({
      spaceId: spaceId,
      pageId: targetPageId ?? scratchWorkspaceId,
      mainFile,
      source,
      mergedFiles,
      dto,
      engine,
      cacheKey,
      signal,
    });

    if (remoteResult) {
      await this.outputService.syncCachedArtifactsToScratch(
        scratchWorkspaceId,
        remoteResult,
      );
    }

    const pipelineResult: CompilePipelineResult =
      remoteResult ??
      (await this.pipeline.execute({
        spaceId: scratchWorkspaceId,
        mainFile,
        engine,
        texLiveVersion,
        draft: dto.draft,
        syntaxOnly: dto.syntaxOnly,
        stopOnFirstError: dto.stopOnFirstError ?? false,
        timeoutMs: effectiveTimeoutMs,
        source,
        files: mergedFiles,
        signal,
        onLogChunk,
      }));

    let finalResult = pipelineResult;
    if (!remoteResult && this.remoteClient.isEnabled()) {
      finalResult = enrichUnreachableRemoteFailure({
        pipelineResult,
        mainFile,
        remoteUrl: this.remoteClient.getBaseUrl(),
      });
    }

    this.metrics.record({
      engine: metricEngine,
      durationMs: finalResult.durationMs,
      success: finalResult.success,
      isCached: false,
      isTimeout: Boolean(finalResult.timedOut),
      pdfSizeBytes: finalResult.pdf
        ? Buffer.byteLength(finalResult.pdf, 'base64')
        : 0,
    });

    if (
      finalResult.success &&
      (finalResult.diagnosticsSummary?.totalErrors ?? 0) === 0 &&
      this.cache &&
      finalResult.pdf &&
      finalResult.pdf.length <= 2 * 1024 * 1024
    ) {
      await this.cache.set(cacheKey, finalResult, 300);
    }

    const formatted = await this.outputService.formatCompileResultForClient({
      result: finalResult,
      responseMode: dto.responseMode,
      spaceId,
      pageId: targetPageId,
      scratchWorkspaceId,
    });

    if (!spaceId.startsWith('adhoc-')) {
      const summary = finalResult.diagnosticsSummary
        ? {
            totalErrors: finalResult.diagnosticsSummary.totalErrors,
            totalWarnings: finalResult.diagnosticsSummary.totalWarnings,
            totalBadboxes: finalResult.diagnosticsSummary.totalBadboxes,
          }
        : undefined;
      const summaryLine = finalResult.success
        ? `[CLSI] Compilation succeeded in ${finalResult.durationMs}ms`
        : `[CLSI] Compilation failed: ${finalResult.error || 'See compiler logs'}`;

      const pdfUrl =
        formatted.success && 'pdfArtifactUrl' in formatted
          ? formatted.pdfArtifactUrl
          : undefined;
      const logArtifactUrl = formatted.logMeta?.logArtifactUrl;

      this.realtimeService?.broadcastCompileProgress(spaceId, {
        status: finalResult.success ? 'success' : 'failed',
        logs: [summaryLine],
        ...(pdfUrl ? { pdfUrl } : {}),
        ...(summary ? { summary } : {}),
        ...(logArtifactUrl ? { logArtifactUrl } : {}),
      });

      if (finalResult.success && this.snapshotService && spaceId !== 'default') {
        const snapshotPageId =
          scratchWorkspaceId !== spaceId ? scratchWorkspaceId : dto.pageId;
        const snapshotKey = `${spaceId}:${snapshotPageId || 'root'}`;
        const lastAt = this.lastAutoSnapshotTimes.get(snapshotKey) || 0;
        if (Date.now() - lastAt >= 30_000) {
          this.lastAutoSnapshotTimes.set(snapshotKey, Date.now());
          if (this.lastAutoSnapshotTimes.size > 1000) {
            const oldestKey = this.lastAutoSnapshotTimes.keys().next().value;
            if (oldestKey) this.lastAutoSnapshotTimes.delete(oldestKey);
          }
          await this.snapshotService
            .createSnapshot(
              spaceId,
              {
                summary: `Compilation milestone (${metricEngine})`,
                isAutomatic: true,
                pageId: snapshotPageId,
              },
              userId ?? null,
              snapshotPageId,
            )
            .catch((err: unknown) => {
              this.logger.debug(
                `Post-compile auto-snapshot skipped for ${spaceId}: ${err}`,
              );
            });
        }
      }
    }

    return formatted;
  }

  public cancelCompile(spaceId: string, userId?: string): boolean {
    return this.compileLock.cancel(spaceId, userId);
  }

  public async forwardSync(dto: ForwardSyncDto, authorizedSpaceId?: string) {
    return await this.synctexService.forwardSync(dto, authorizedSpaceId);
  }

  public async reverseSync(dto: ReverseSyncDto, authorizedSpaceId?: string) {
    return await this.synctexService.reverseSync(dto, authorizedSpaceId);
  }

  public async getWordCount(
    dto: ClsiWordCountDto,
    authorizedSpaceId?: string,
  ): Promise<{
    success: boolean;
    stats?: WordCountStats;
    error?: string;
  }> {
    return await this.wordCountService.count(dto, authorizedSpaceId);
  }

  public async listAuxFiles(spaceId: string, pageId?: string) {
    const scratchId = pageId || spaceId;
    let files = await this.workspace.listAuxFiles(scratchId);
    if (files.length === 0 && this.remoteClient.isEnabled()) {
      files = (await this.remoteClient.tryRemoteListAuxFiles(scratchId)) ?? [];
    }
    return { files };
  }

  public async downloadAuxFile(
    spaceId: string,
    filename: string,
    res: FastifyReply,
    pageId?: string,
  ) {
    return await this.outputService.downloadAuxFile(
      spaceId,
      filename,
      res,
      pageId,
    );
  }

  public async readAuxFileBuffer(
    spaceId: string,
    filename: string,
    pageId?: string,
  ): Promise<Buffer | null> {
    const scratchId = pageId || spaceId;
    return await this.workspace.readAuxFile(scratchId, filename);
  }

  public async getLastBuildSummary(
    spaceId: string,
    defaultMainFile = 'main.tex',
    pageId?: string,
  ): Promise<EditorLastBuildSummary> {
    return await this.outputService.getLastBuildSummary(
      spaceId,
      defaultMainFile,
      pageId,
    );
  }

  public async getHealthReport() {
    if (this.remoteClient.isEnabled()) {
      const remoteHealth = await this.remoteClient.tryRemoteHealthCheck();
      if (remoteHealth !== null) {
        return {
          ...remoteHealth,
          remote: {
            url: this.remoteClient.getBaseUrl(),
            reachable: true,
          },
        };
      }
      const localReport = await this.healthCheck.checkHealth();
      return {
        ...localReport,
        remote: {
          url: this.remoteClient.getBaseUrl(),
          reachable: false,
        },
      };
    }
    return this.healthCheck.checkHealth();
  }

  public getMetricsSummary() {
    return this.metrics.getSummary();
  }

  public getPrometheusMetrics(): string {
    return this.metrics.toPrometheus();
  }

  public async cleanStaleScratch(options?: DiskUsageOptions) {
    return this.diskUsageCleaner.cleanStaleWorkspaces(options);
  }

  public async enforceScratchQuota(options?: DiskUsageOptions) {
    return this.diskUsageCleaner.enforceDiskQuota(options);
  }

  public async cleanScratch(
    spaceId: string,
    pageId?: string,
  ): Promise<{ success: boolean; spaceId: string }> {
    const scratchId = pageId || spaceId;
    await Promise.all([
      this.pipeline.runWithWorkspaceLock(scratchId, () =>
        this.workspace.cleanScratch(scratchId),
      ),
      this.remoteClient.isEnabled()
        ? this.remoteClient.tryRemoteCleanScratch(scratchId).catch(() => false)
        : Promise.resolve(false),
    ]);
    return { success: true, spaceId: scratchId };
  }

  public async downloadAllArtifactsZip(
    spaceId: string,
    res: FastifyReply,
    pageId?: string,
  ): Promise<void> {
    return await this.outputService.downloadAllArtifactsZip(
      spaceId,
      res,
      pageId,
    );
  }
}
