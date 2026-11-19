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
import { DocstoreService } from '@/modules/pages/docstore/docstore.service';
import { FilestoreService } from '@/modules/pages/filestore/filestore.service';
import {
  CompilePageDto,
  ClsiWordCountDto,
  ClsiAiTransformDto,
  ClsiAiFixErrorDto,
  ClsiAiGenerateTableDto,
} from '../dto/clsi.dto';
import { ForwardSyncDto, ReverseSyncDto } from '../dto/synctex.dto';
import {
  SyncPoint,
  ReverseSyncPoint,
  WordCountStats,
} from '../domain/clsi.ports';
import {
  WorkspaceRepository,
  DiskUsageCleaner,
  DiskUsageOptions,
} from '../repositories/workspace.repository';
import {
  CompileLogAnalyzer,
  SyntaxLinter,
} from '@/modules/pages/diagnostics/domain';
import { AiActionResult, AiErrorFixResult } from '../domain/ai-assistant';
import { SyncTexProcessor } from '../domain/synctex.parser';
import { TexWordCounter } from '../domain/tex-word.counter';
import { PlannedFileSet } from '../domain/fileset.planner';
import {
  CompilePipeline,
  CompilePipelineResult,
  LocalProcessRunner,
  DockerSandboxRunner,
  LatexmkEngine,
  ClsiHealthCheck,
} from './compile-pipeline.service';
import { CompileQueueService } from './compile-queue.service';
import { ClsiMetrics } from '../domain/clsi.metrics';
import { RealtimeFacade } from '@/modules/realtime/realtime.facade';
import { RemoteClsiClientAdapter } from './remote-clsi.client';
import { WorkspacePlannerService } from './workspace-planner.service';
import {
  parseSandboxConfig,
  buildSandboxProfileFromConfig,
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
  getLastBuildSummaryHelper,
  syncCachedArtifactsToScratchHelper,
} from './clsi-artifacts.helper';
import {
  type ClsiAiEngine,
  fixLatexErrorHelper,
  generateLatexTableHelper,
  transformAcademicTextHelper,
} from './clsi-ai.helper';

export type ClsiCompileResult = CompilePipelineResult;
export type { EditorLastBuildSummary };

@Injectable()
export class ClsiService implements OnModuleDestroy {
  private readonly logger = new Logger(ClsiService.name);
  private readonly workspace: WorkspaceRepository;
  private readonly pipeline: CompilePipeline;
  private readonly logParser: CompileLogAnalyzer;
  private readonly syntaxLinter: SyntaxLinter = new SyntaxLinter();
  private readonly synctexParser: SyncTexProcessor;
  private readonly wordCounter: TexWordCounter;
  private readonly fairQueue: CompileQueueService;
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
    @Optional() fairQueue?: CompileQueueService,
    @Optional()
    private readonly aiEngine?: ClsiAiEngine,
    @Optional() private readonly prisma?: PrismaService,
    @Optional() private readonly docstoreService?: DocstoreService,
    @Optional() private readonly filestoreService?: FilestoreService,
  ) {
    this.fairQueue = fairQueue ?? new CompileQueueService();
    const rawMode = this.configService
      .get<string>('CLSI_SANDBOX_MODE')
      ?.toLowerCase();
    const sandboxConfig = parseSandboxConfig({
      env: {
        CLSI_SANDBOX_MODE: rawMode || undefined,
        CLSI_SANDBOX_IMAGE:
          this.configService.get<string>('CLSI_SANDBOX_IMAGE') ||
          this.configService.get<string>('CLSI_DOCKER_IMAGE') ||
          undefined,
        CLSI_URL: this.configService.get<string>('CLSI_URL') || undefined,
        CLSI_SANDBOX_USER:
          this.configService.get<string>('CLSI_SANDBOX_USER') || undefined,
        CLSI_SANDBOX_MEMORY_MB:
          this.configService.get<string>('CLSI_SANDBOX_MEMORY_MB') || undefined,
        CLSI_SANDBOX_CPUS:
          this.configService.get<string>('CLSI_SANDBOX_CPUS') || undefined,
        CLSI_SANDBOX_PIDS:
          this.configService.get<string>('CLSI_SANDBOX_PIDS') || undefined,
        CLSI_SANDBOX_FSIZE_MB:
          this.configService.get<string>('CLSI_SANDBOX_FSIZE_MB') || undefined,
        CLSI_SANDBOX_NOFILE:
          this.configService.get<string>('CLSI_SANDBOX_NOFILE') || undefined,
        CLSI_SANDBOX_TMPFS_MB:
          this.configService.get<string>('CLSI_SANDBOX_TMPFS_MB') || undefined,
        CLSI_SANDBOX_TIMEOUT_MS:
          this.configService.get<string>('CLSI_SANDBOX_TIMEOUT_MS') ||
          undefined,
        CLSI_SANDBOX_RUNTIME:
          this.configService.get<string>('CLSI_SANDBOX_RUNTIME') || undefined,
        CLSI_SCRATCH_DIR:
          this.configService.get<string>('CLSI_SCRATCH_DIR') ||
          this.configService.get<string>('SCRATCH_DIR') ||
          undefined,
        NODE_ENV: this.configService.get<string>('NODE_ENV') || undefined,
      },
      isProduction: this.configService.get<string>('NODE_ENV') === 'production',
    });

    const scratchDir = sandboxConfig.scratchDir;
    const latexmkBin =
      this.configService.get<string>('LATEXMK_BIN') || 'latexmk';

    // Workspace & Real Sandbox/Engine seams
    this.workspace = workspace ?? new WorkspaceRepository(scratchDir);

    this.remoteClient =
      remoteClient ??
      new RemoteClsiClientAdapter(this.configService, this.cache);
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
    this.fairQueue.onModuleDestroy();
  }

  private hashSource(source: string): string {
    return crypto
      .createHash('sha256')
      .update(source || '')
      .digest('hex');
  }

  private async isQueueActive(): Promise<boolean> {
    if (!this.compileQueue) return false;
    if (
      this.configService.get<string>('DISABLE_CLSI_QUEUE') === 'true' ||
      process.env.DISABLE_CLSI_QUEUE === 'true'
    ) {
      return false;
    }
    try {
      const workers = await this.compileQueue.getWorkers();
      return Array.isArray(workers) && workers.length > 0;
    } catch {
      return false;
    }
  }

  private async queueCompileJob(
    dto: CompilePageDto,
    userId?: string,
    authorizedProjectId?: string,
  ): Promise<ClsiCompileResult> {
    if (!this.compileQueue) {
      throw new Error('CLSI compile queue is not initialized');
    }

    const spaceId = authorizedProjectId || dto.spaceId || 'default';
    const queueScopeId = dto.pageId || spaceId;
    const effectiveTimeoutMs = dto.timeoutMs ?? 240000;

    // Pre-compile Yjs flush in the API process before dispatching to external BullMQ worker
    if (this.realtimeService && spaceId && spaceId !== 'default') {
      try {
        await this.realtimeService.flushProjectBeforeCompile(spaceId);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `Pre-queue Yjs flush encountered an error for project ${spaceId}: ${msg}`,
        );
      }
    }

    // Cancel any previous queued BullMQ job for this manuscript page/space
    const existingJobId = this.activeQueueJobIds.get(queueScopeId);
    if (existingJobId) {
      try {
        const oldJob = await this.compileQueue.getJob(existingJobId);
        if (oldJob) {
          await oldJob.remove().catch(() => {});
        }
      } catch {
        /* ignore stale job removal */
      }
    }

    const jobId = `clsi-${queueScopeId}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const job = await this.compileQueue.add(
      'clsi-compile',
      {
        dto,
        userId,
        authorizedProjectId,
      },
      {
        jobId,
        removeOnComplete: { age: 60, count: 10 },
        removeOnFail: { age: 300, count: 25 },
      },
    );
    this.activeQueueJobIds.set(queueScopeId, jobId);

    const startTime = Date.now();
    const pollIntervalMs = 200;
    try {
      while (Date.now() - startTime < effectiveTimeoutMs) {
        if (this.activeQueueJobIds.get(queueScopeId) !== jobId) {
          throw new HttpException('Compilation superseded or cancelled', 409);
        }
        const state = await job.getState();
        if (state === 'completed') {
          const freshJob = await this.compileQueue.getJob(job.id!);
          return freshJob?.returnvalue as ClsiCompileResult;
        }
        if (state === 'failed') {
          const freshJob = await this.compileQueue.getJob(job.id!);
          const reason =
            freshJob?.failedReason || 'Job execution failed in CLSI worker';
          const workerErr = new Error(reason) as Error & {
            isWorkerExecutionError?: boolean;
          };
          workerErr.isWorkerExecutionError = true;
          throw workerErr;
        }
        await new Promise((r) => setTimeout(r, pollIntervalMs));
      }

      const timeoutErr = new Error(
        `CLSI compile job ${job.id} timed out after ${effectiveTimeoutMs}ms in queue`,
      ) as Error & { isWorkerExecutionError?: boolean };
      timeoutErr.isWorkerExecutionError = true;
      throw timeoutErr;
    } finally {
      if (this.activeQueueJobIds.get(queueScopeId) === jobId) {
        this.activeQueueJobIds.delete(queueScopeId);
      }
    }
  }

  public async enqueueCompile(
    dto: CompilePageDto,
    userId?: string,
    authorizedProjectId?: string,
  ): Promise<{ jobId: string }> {
    if (!this.compileQueue) {
      throw new Error('CLSI compile queue is not initialized');
    }
    const projectId = authorizedProjectId || dto.spaceId || 'default';
    const queueScopeId = dto.pageId || projectId;
    const job = await this.compileQueue.add(
      'clsi-compile',
      { dto, userId, authorizedProjectId },
      {
        jobId: `clsi-${queueScopeId}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
        removeOnComplete: { age: 60, count: 10 },
        removeOnFail: { age: 300, count: 25 },
      },
    );
    return { jobId: job.id! };
  }

  public async compile(
    dto: CompilePageDto,
    userId?: string,
    authorizedProjectId?: string,
  ): Promise<ClsiCompileResult> {
    if (await this.isQueueActive()) {
      try {
        return await this.queueCompileJob(dto, userId, authorizedProjectId);
      } catch (err: unknown) {
        if (
          err instanceof HttpException ||
          (err as { isWorkerExecutionError?: boolean })?.isWorkerExecutionError
        ) {
          throw err;
        }
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `CLSI queue dispatch failed (Redis/Queue unavailable), falling back to inline fairQueue: ${msg}`,
        );
      }
    }

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

    return await this.fairQueue.schedule(
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
        const cacheKey = `flux:clsi:compile:${this.hashSource(
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
        )}`;
        const cacheable = !!(dto.useCache && plan.hasMainContent);

        if (cacheable && this.cache) {
          const cacheLookupStart = Date.now();
          const cached = await this.cache.get<ClsiCompileResult>(cacheKey);
          if (cached && cached.success) {
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
                : 0,
            });
            return cached;
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
        );
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
  ): Promise<ClsiCompileResult> {
    const mainFile = plan.mainFile;
    const dbProjectId = projectId.startsWith('adhoc-') ? 'default' : projectId;
    const mergedFiles = await this.workspacePlanner.hydrateFiles(
      dbProjectId,
      plan,
      scratchWorkspaceId,
    );
    const rawMain = mergedFiles[mainFile] ?? dto.source ?? '';
    const source = Buffer.isBuffer(rawMain)
      ? rawMain.toString('utf8')
      : rawMain;

    if (dto.forceClean) {
      await this.pipeline.runWithProjectLock(
        scratchWorkspaceId,
        () => this.workspace.cleanScratch(scratchWorkspaceId),
        signal,
      );
    }

    const remoteResult = await this.remoteClient.tryRemoteClsiCompile({
      projectId: scratchWorkspaceId,
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

    this.metrics.record({
      engine: metricEngine,
      durationMs: pipelineResult.durationMs,
      success: pipelineResult.success,
      isCached: false,
      isTimeout: Boolean(pipelineResult.timedOut),
      pdfSizeBytes: pipelineResult.pdf
        ? Buffer.byteLength(pipelineResult.pdf, 'base64')
        : 0,
    });

    if (
      pipelineResult.success &&
      this.cache &&
      pipelineResult.pdf &&
      pipelineResult.pdf.length <= 2 * 1024 * 1024
    ) {
      await this.cache.set(cacheKey, pipelineResult, 300);
    }

    if (!projectId.startsWith('adhoc-')) {
      this.realtimeService?.broadcastCompileProgress(projectId, {
        status: pipelineResult.success ? 'success' : 'failed',
        logs: pipelineResult.logs ? [pipelineResult.logs] : [],
      });

      if (pipelineResult.success) {
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

    return pipelineResult;
  }

  public cancelCompile(projectId: string): boolean {
    const existingJobId = this.activeQueueJobIds.get(projectId);
    if (existingJobId && this.compileQueue) {
      this.activeQueueJobIds.delete(projectId);
      this.compileQueue
        .getJob(existingJobId)
        .then((job) => job?.remove())
        .catch(() => {});
    }
    return this.fairQueue.cancel(projectId) || Boolean(existingJobId);
  }

  public async forwardSync(
    dto: ForwardSyncDto,
    authorizedProjectId?: string,
  ): Promise<{
    success: boolean;
    result?: SyncPoint;
    error?: string;
  }> {
    return await forwardSyncHelper(
      {
        workspace: this.workspace,
        synctexParser: this.synctexParser,
        wordCounter: this.wordCounter,
        synctexDiskCache: this.synctexDiskCache,
        remoteClient: this.remoteClient,
        workspacePlanner: this.workspacePlanner,
      },
      dto,
      authorizedProjectId,
    );
  }

  public async reverseSync(
    dto: ReverseSyncDto,
    authorizedProjectId?: string,
  ): Promise<{
    success: boolean;
    result?: ReverseSyncPoint;
    error?: string;
  }> {
    return await reverseSyncHelper(
      {
        workspace: this.workspace,
        synctexParser: this.synctexParser,
        wordCounter: this.wordCounter,
        synctexDiskCache: this.synctexDiskCache,
        remoteClient: this.remoteClient,
        workspacePlanner: this.workspacePlanner,
      },
      dto,
      authorizedProjectId,
    );
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
    const files = await this.workspace.listAuxFiles(scratchId);
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
      if (remoteHealth && remoteHealth.status === 'healthy') {
        return remoteHealth;
      }
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
    await this.pipeline.runWithProjectLock(scratchId, () =>
      this.workspace.cleanScratch(scratchId),
    );
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

  /**
   * Server-side LaTeX AI academic writing transformation:
   * Masks LaTeX math, citations, and references, applies academic strategy via EngineService
   * (with heuristic fallback), and unmasks all LaTeX entities verbatim.
   */
  public async transformAcademicText(
    dto: ClsiAiTransformDto,
    userId?: string,
  ): Promise<AiActionResult> {
    return await transformAcademicTextHelper(
      this.prisma,
      this.aiEngine,
      dto,
      userId,
    );
  }

  /**
   * Server-side LaTeX compiler error remediation:
   * Queries EngineService for structured JSON fix, falls back to FastSyntaxLinter.autoFix
   * and expert heuristic rules.
   */
  public async fixLatexError(
    dto: ClsiAiFixErrorDto,
    userId?: string,
  ): Promise<AiErrorFixResult> {
    return await fixLatexErrorHelper(
      this.prisma,
      this.aiEngine,
      this.syntaxLinter,
      dto,
      userId,
    );
  }

  /**
   * Server-side LaTeX table generator from a natural language prompt.
   */
  public async generateLatexTable(
    dto: ClsiAiGenerateTableDto,
    userId?: string,
  ): Promise<{ table: string }> {
    return await generateLatexTableHelper(
      this.prisma,
      this.aiEngine,
      dto,
      userId,
    );
  }
}
