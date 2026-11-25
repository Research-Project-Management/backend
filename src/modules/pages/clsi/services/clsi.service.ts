/**
 * modules/pages/clsi/services/clsi.service.ts
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
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { MANUSCRIPT_CLSI_QUEUE } from '@/core/infrastructure/queue/bullmq.config';
import { ConfigService } from '@nestjs/config';
import { FastifyReply } from 'fastify';
import * as crypto from 'crypto';
import { PrismaService, RedisCacheService } from '@/core';
import { PagesDomainError } from '@/modules/pages/core/domain/pages-domain.error';
import { PAGES_CACHE_KEYS } from '@/modules/pages/core/pages.cache-keys';
import { DocstoreService } from '@/modules/pages/docstore/docstore.service';
import { FilestoreService } from '@/modules/pages/filestore/filestore.service';
import {
  CompilePageDto,
  ClsiWordCountDto,
} from '../dto/clsi.dto';
import { ForwardSyncDto, ReverseSyncDto } from '../dto/synctex.dto';
import { WordCountStats } from '../domain/clsi.ports';
import {
  WorkspaceRepository,
  DiskUsageCleaner,
  DiskUsageOptions,
} from '../repositories/workspace.repository';
import { CompileLogAnalyzer } from '../domain/log-parser/compile-log.analyzer';
import { SyncTexProcessor } from '../domain/synctex.parser';
import { TexWordCounter } from '../domain/tex-word.counter';
import {
  PlannedFileSet,
  validatePlannedFileSet,
} from '../domain/fileset.planner';
import {
  CompilePipeline,
  CompilePipelineResult,
  LocalProcessRunner,
  DockerSandboxRunner,
  LatexmkEngine,
  ClsiHealthCheck,
} from './compile-pipeline.service';
import { CompileLockService, getCompileName } from './compile-lock.service';
import { ClsiQueueUnavailableError } from '../domain/sandbox.errors';
import { ClsiMetrics } from '../domain/clsi.metrics';
import { RealtimeFacade } from '@/modules/realtime/realtime.facade';
import { RemoteClsiClientAdapter } from './remote-clsi.client';
import { WorkspacePlannerService } from './workspace-planner.service';
import {
  parseSandboxConfig,
  buildSandboxProfileFromConfig,
  extractSandboxEnvFromConfigService,
} from './sandbox/sandbox-config';
import {
  type SynctexDiskCacheEntry,
  forwardSyncHelper,
  getWordCountHelper,
  reverseSyncHelper,
} from './clsi-synctex-wordcount.helper';
import {
  type EditorLastBuildSummary,
  downloadAllArtifactsZipHelper,
  downloadAuxFileHelper,
  enrichUnreachableRemoteFailure,
  formatCompileResultForClient,
  getLastBuildSummaryHelper,
  syncCachedArtifactsToScratchHelper,
} from './clsi-artifacts.helper';

export type ClsiCompileResult = CompilePipelineResult;
export type { EditorLastBuildSummary };

@Injectable()
export class ClsiService implements OnModuleDestroy {
  private readonly logger = new Logger(ClsiService.name);
  private readonly workspace: WorkspaceRepository;
  private readonly pipeline: CompilePipeline;
  private readonly logParser: CompileLogAnalyzer;
  private readonly synctexParser: SyncTexProcessor;
  private readonly wordCounter: TexWordCounter;
  private readonly compileLock: CompileLockService;
  private readonly synctexDiskCache = new Map<string, SynctexDiskCacheEntry>();
  private readonly activeQueueJobIds = new Map<string, string>();
  private readonly diskUsageCleaner: DiskUsageCleaner;
  private readonly healthCheck: ClsiHealthCheck;
  private readonly metrics: ClsiMetrics = ClsiMetrics.getInstance();
  private readonly remoteClient: RemoteClsiClientAdapter;
  private readonly workspacePlanner: WorkspacePlannerService;

  constructor(
    private readonly configService: ConfigService,
    @Optional() private readonly cache?: RedisCacheService,
    @Optional() private readonly realtimeService?: RealtimeFacade,
    @Optional()
    @InjectQueue(MANUSCRIPT_CLSI_QUEUE)
    private readonly compileQueue?: Queue,
    @Optional() remoteClient?: RemoteClsiClientAdapter,
    @Optional() workspacePlanner?: WorkspacePlannerService,
    @Optional() workspace?: WorkspaceRepository,
    @Optional() latexmkEngine?: LatexmkEngine,
    @Optional() logParser?: CompileLogAnalyzer,
    @Optional() synctexProcessor?: SyncTexProcessor,
    @Optional() wordCounter?: TexWordCounter,
    @Optional() diskUsageCleaner?: DiskUsageCleaner,
    @Optional() healthCheck?: ClsiHealthCheck,
    @Optional() pipeline?: CompilePipeline,
    @Optional() compileLock?: CompileLockService,
    @Optional() private readonly prisma?: PrismaService,
    @Optional() private readonly docstoreService?: DocstoreService,
    @Optional() private readonly filestoreService?: FilestoreService,
  ) {
    this.compileLock = compileLock ?? new CompileLockService();
    const sandboxConfig = parseSandboxConfig({
      env: extractSandboxEnvFromConfigService(this.configService),
      isProduction: this.configService.get<string>('NODE_ENV') === 'production',
    });

    const scratchDir = sandboxConfig.scratchDir;
    const latexmkBin =
      this.configService.get<string>('LATEXMK_BIN') || 'latexmk';

    // Workspace & Real Sandbox/Engine seams
    this.workspace = workspace ?? new WorkspaceRepository(scratchDir);

    this.remoteClient =
      remoteClient ?? new RemoteClsiClientAdapter(this.configService);
    this.workspacePlanner =
      workspacePlanner ??
      new WorkspacePlannerService(
        this.prisma,
        this.docstoreService,
        this.filestoreService,
        this.realtimeService,
        this.workspace,
      );

    // Pure in-process domain logic
    this.logParser = logParser ?? new CompileLogAnalyzer();
    this.synctexParser = synctexProcessor ?? new SyncTexProcessor();
    this.wordCounter = wordCounter ?? new TexWordCounter();

    const needsRunner = !latexmkEngine || !healthCheck;
    const runner = needsRunner
      ? sandboxConfig.mode === 'container'
        ? new DockerSandboxRunner(
            sandboxConfig.image,
            `${sandboxConfig.memoryMb}m`,
            `${sandboxConfig.cpus}`,
            undefined,
            buildSandboxProfileFromConfig(sandboxConfig),
          )
        : new LocalProcessRunner()
      : undefined;

    const resolvedLatexmkEngine =
      latexmkEngine ?? new LatexmkEngine(runner!, latexmkBin, 'pdflatex');

    this.diskUsageCleaner =
      diskUsageCleaner ?? new DiskUsageCleaner(scratchDir);
    this.healthCheck = healthCheck ?? new ClsiHealthCheck(runner!, scratchDir);

    this.pipeline =
      pipeline ??
      new CompilePipeline(
        this.workspace,
        resolvedLatexmkEngine,
        this.logParser,
      );
  }

  public onModuleDestroy(): void {
    this.compileLock.onModuleDestroy();
  }

  private hashSource(source: string): string {
    return crypto
      .createHash('sha256')
      .update(source || '')
      .digest('hex');
  }

  public async enqueueCompile(
    dto: CompilePageDto,
    userId?: string,
    authorizedProjectId?: string,
  ): Promise<{ jobId: string }> {
    if (!this.compileQueue) {
      throw new ClsiQueueUnavailableError();
    }
    const projectId = authorizedProjectId || dto.spaceId || 'default';
    const compileTargetId = dto.pageId || projectId;
    const job = await this.compileQueue.add(
      'clsi-compile',
      { dto, userId, authorizedProjectId },
      {
        jobId: `clsi-${compileTargetId}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
        removeOnComplete: { age: 60, count: 10 },
        removeOnFail: { age: 300, count: 25 },
      },
    );
    return { jobId: job.id! };
  }

  /**
   * Citation: Overleaf `services/web/app/src/Features/Compile/CompileManager.mjs` (lines 30-135) &
   * `services/clsi/app/js/CompileController.js` (lines 48-210).
   * Executes compilation synchronously against the target CLSI workspace without routing
   * through a shared Redis/BullMQ pull queue (preserving local disk `.aux/.fdb_latexmk` affinity).
   */
  public async compile(
    dto: CompilePageDto,
    userId?: string,
    authorizedProjectId?: string,
  ): Promise<ClsiCompileResult> {
    return await this.compileInline(dto, userId, authorizedProjectId);
  }

  public async compileInline(
    dto: CompilePageDto,
    _userId?: string,
    authorizedProjectId?: string,
  ): Promise<ClsiCompileResult> {
    const requestedEngine = dto.engine;
    const texLiveVersion = dto.texLiveVersion || '2025';
    const { spaceId: resolvedSpaceId, pageId: manuscriptPageId } =
      await this.workspacePlanner.resolvePageCompileContext(
        dto,
        authorizedProjectId,
      );
    const effectiveSpaceId =
      resolvedSpaceId && resolvedSpaceId !== 'default'
        ? resolvedSpaceId
        : _userId
          ? `adhoc-${_userId}`
          : `adhoc-${crypto.randomUUID()}`;
    const scratchWorkspaceId = manuscriptPageId || effectiveSpaceId;
    const effectiveTimeoutMs = dto.timeoutMs ?? 240000;
    const metricEngine = requestedEngine || 'pdflatex';

    return await this.compileLock.runWithLock(
      scratchWorkspaceId,
      _userId,
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

        const plan = await this.workspacePlanner.planFiles(
          effectiveSpaceId.startsWith('adhoc-') ? 'default' : effectiveSpaceId,
          dto,
          manuscriptPageId,
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
            await syncCachedArtifactsToScratchHelper(
              this.workspace,
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
            return await formatCompileResultForClient({
              result: cached,
              responseMode: dto.responseMode,
              projectId: effectiveSpaceId,
              pageId: manuscriptPageId,
              scratchWorkspaceId,
              workspace: this.workspace,
            });
          }
        }

        return await this.runScheduledCompile(
          effectiveSpaceId,
          plan,
          dto,
          requestedEngine,
          cacheKey,
          effectiveTimeoutMs,
          metricEngine,
          texLiveVersion,
          signal,
          onLogChunk,
          _userId,
          scratchWorkspaceId,
          manuscriptPageId,
        );
      },
      {
        priority: dto.priority ?? 'manual',
        ...(dto.forceClean ? { forceClean: true } : {}),
      },
    );
  }

  private async runScheduledCompile(
    projectId: string,
    plan: PlannedFileSet,
    dto: CompilePageDto,
    engine: string | undefined,
    cacheKey: string,
    effectiveTimeoutMs: number,
    metricEngine: string,
    texLiveVersion: string,
    signal: AbortSignal,
    onLogChunk: (chunk: string) => void,
    _userId?: string,
    scratchWorkspaceId: string = projectId,
    manuscriptPageId?: string,
  ): Promise<ClsiCompileResult> {
    const mainFile = plan.mainFile;
    const dbProjectId = projectId.startsWith('adhoc-') ? 'default' : projectId;

    if (dto.forceClean) {
      await this.pipeline.runWithProjectLock(
        scratchWorkspaceId,
        () => this.workspace.cleanScratch(scratchWorkspaceId),
        signal,
      );
    }

    const mergedFiles = await this.workspacePlanner.hydrateFiles(
      dbProjectId,
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
      projectId: scratchWorkspaceId,
      spaceId: projectId,
      pageId: manuscriptPageId ?? scratchWorkspaceId,
      mainFile,
      source,
      mergedFiles,
      dto,
      engine,
      cacheKey,
      signal,
    });

    if (remoteResult) {
      await syncCachedArtifactsToScratchHelper(
        this.workspace,
        scratchWorkspaceId,
        remoteResult,
      );
    }

    const pipelineResult: CompilePipelineResult =
      remoteResult ??
      (await this.pipeline.execute({
        projectId: scratchWorkspaceId,
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

    const formatted = await formatCompileResultForClient({
      result: finalResult,
      responseMode: dto.responseMode,
      projectId,
      pageId: manuscriptPageId,
      scratchWorkspaceId,
      workspace: this.workspace,
    });

    if (!projectId.startsWith('adhoc-')) {
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

      this.realtimeService?.broadcastCompileProgress(projectId, {
        status: finalResult.success ? 'success' : 'failed',
        logs: [summaryLine],
        ...(pdfUrl ? { pdfUrl } : {}),
        ...(summary ? { summary } : {}),
        ...(logArtifactUrl ? { logArtifactUrl } : {}),
      });

      if (finalResult.success) {
        await this.workspacePlanner.recordCompileSnapshotIfEligible(
          projectId,
          mergedFiles,
          metricEngine,
          _userId,
          plan,
          scratchWorkspaceId !== projectId ? scratchWorkspaceId : dto.pageId,
        );
      }
    }

    return formatted;
  }

  public cancelCompile(projectId: string, userId?: string): boolean {
    const cancelledLock = this.compileLock.cancel(projectId, userId);
    const compileKey = getCompileName(projectId, userId);
    const existingJobId = this.activeQueueJobIds.get(compileKey);
    if (existingJobId && this.compileQueue) {
      this.activeQueueJobIds.delete(compileKey);
      this.compileQueue
        .getJob(existingJobId)
        .then((job) => job?.remove())
        .catch(() => {});
    }
    return cancelledLock || Boolean(existingJobId);
  }

  public async forwardSync(dto: ForwardSyncDto, authorizedProjectId?: string) {
    return await forwardSyncHelper(
      this.buildSynctexContext(),
      dto,
      authorizedProjectId,
    );
  }

  public async reverseSync(dto: ReverseSyncDto, authorizedProjectId?: string) {
    return await reverseSyncHelper(
      this.buildSynctexContext(),
      dto,
      authorizedProjectId,
    );
  }

  private buildSynctexContext() {
    return {
      workspace: this.workspace,
      synctexParser: this.synctexParser,
      wordCounter: this.wordCounter,
      synctexDiskCache: this.synctexDiskCache,
      remoteClient: this.remoteClient,
      workspacePlanner: this.workspacePlanner,
    };
  }

  public async getWordCount(
    dto: ClsiWordCountDto,
    authorizedProjectId?: string,
  ): Promise<{
    success: boolean;
    stats?: WordCountStats;
    error?: string;
  }> {
    return await getWordCountHelper(
      {
        workspacePlanner: this.workspacePlanner,
        wordCounter: this.wordCounter,
      },
      dto,
      authorizedProjectId,
    );
  }

  public async listAuxFiles(projectId: string, pageId?: string) {
    const scratchId = pageId || projectId;
    let files = await this.workspace.listAuxFiles(scratchId);
    if (files.length === 0 && this.remoteClient.isEnabled()) {
      files = (await this.remoteClient.tryRemoteListAuxFiles(scratchId)) ?? [];
    }
    return { files };
  }

  public async downloadAuxFile(
    projectId: string,
    filename: string,
    res: FastifyReply,
    pageId?: string,
  ) {
    return await downloadAuxFileHelper(
      this.workspace,
      projectId,
      filename,
      res,
      pageId,
      this.remoteClient,
    );
  }

  public async readAuxFileBuffer(
    projectId: string,
    filename: string,
    pageId?: string,
  ): Promise<Buffer | null> {
    const scratchId = pageId || projectId;
    return await this.workspace.readAuxFile(scratchId, filename);
  }

  public async getLastBuildSummary(
    projectId: string,
    defaultMainFile = 'main.tex',
    pageId?: string,
  ): Promise<EditorLastBuildSummary> {
    return await getLastBuildSummaryHelper(
      this.workspace,
      this.logParser,
      projectId,
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
    return this.diskUsageCleaner.cleanStaleProjects(options);
  }

  public async enforceScratchQuota(options?: DiskUsageOptions) {
    return this.diskUsageCleaner.enforceDiskQuota(options);
  }

  public async cleanProjectScratch(
    projectId: string,
    pageId?: string,
  ): Promise<{ success: boolean; projectId: string }> {
    const scratchId = pageId || projectId;
    await Promise.all([
      this.pipeline.runWithProjectLock(scratchId, () =>
        this.workspace.cleanScratch(scratchId),
      ),
      this.remoteClient.isEnabled()
        ? this.remoteClient.tryRemoteCleanScratch(scratchId).catch(() => false)
        : Promise.resolve(false),
    ]);
    return { success: true, projectId: scratchId };
  }

  public async downloadAllArtifactsZip(
    projectId: string,
    res: FastifyReply,
    pageId?: string,
  ): Promise<void> {
    return await downloadAllArtifactsZipHelper(
      this.workspace,
      projectId,
      res,
      pageId,
    );
  }
}
