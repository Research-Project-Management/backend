/**
 * modules/manuscripts/clsi/services/clsi.service.ts
 * Deep module orchestrating CLSI compile operations, caching, SyncTeX coordinate
 * resolution, and academic word counts.
 */

import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
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
import * as fs from 'fs/promises';
import * as path from 'path';
import { RedisCacheService } from '@/core';
import { CompileManuscriptDto, ClsiWordCountDto } from '../dto/clsi.dto';
import { ForwardSyncDto, ReverseSyncDto } from '../dto/synctex.dto';
import {
  SyncPoint,
  ReverseSyncPoint,
  WordCountStats,
} from '../domain/clsi.ports';
import {
  OverleafIncrementalWorkspace,
  DiskUsageCleaner,
  DiskUsageOptions,
  createZipStreamFromDisk,
  ZipDiskEntry,
} from '../repositories/incremental-workspace.repository';
import { CompileLogAnalyzer } from '@/modules/manuscripts/diagnostics/domain';
import { SyncTexProcessor } from '../domain/synctex.parser';
import { TexWordCounter } from '../domain/tex-word.counter';
import { PlannedFileSet } from '../domain/compile-fileset.planner';
import {
  CompilePipeline,
  CompilePipelineResult,
  LocalProcessRunner,
  DockerSandboxRunner,
  LatexmkEngine,
  ClsiHealthCheck,
} from './compile-pipeline.service';
import { CompileFairQueue } from './compile-fair-queue.service';
import { ClsiMetrics } from '../domain/clsi.metrics';
import { RealtimeFacade } from '@/modules/realtime/realtime.facade';
import { RemoteClsiClientAdapter } from './remote-clsi.client';
import { ClsiWorkspacePlannerService } from './workspace-planner.service';
import {
  parseSandboxConfig,
  buildSandboxProfileFromConfig,
} from './sandbox/sandbox-config';

export type ClsiCompileResult = CompilePipelineResult;

@Injectable()
export class ClsiService implements OnModuleDestroy {
  private readonly logger = new Logger(ClsiService.name);
  private readonly workspace: OverleafIncrementalWorkspace;
  private readonly pipeline: CompilePipeline;
  private readonly logParser: CompileLogAnalyzer;
  private readonly synctexParser: SyncTexProcessor;
  private readonly wordCounter: TexWordCounter;
  private readonly fairQueue: CompileFairQueue;
  private readonly synctexDiskCache = new Map<
    string,
    { mtimeMs: number; size: number; content: string }
  >();
  private readonly activeQueueJobIds = new Map<string, string>();
  private readonly diskUsageCleaner: DiskUsageCleaner;
  private readonly healthCheck: ClsiHealthCheck;
  private readonly metrics: ClsiMetrics = ClsiMetrics.getInstance();
  private readonly remoteClient: RemoteClsiClientAdapter;
  private readonly workspacePlanner: ClsiWorkspacePlannerService;

  constructor(
    private readonly configService: ConfigService,
    @Optional() private readonly cache?: RedisCacheService,
    @Optional() private readonly realtimeService?: RealtimeFacade,
    @Optional()
    @InjectQueue(MANUSCRIPT_CLSI_QUEUE)
    private readonly compileQueue?: Queue,
    @Optional() remoteClient?: RemoteClsiClientAdapter,
    @Optional() workspacePlanner?: ClsiWorkspacePlannerService,
    @Optional() workspace?: OverleafIncrementalWorkspace,
    @Optional() latexmkEngine?: LatexmkEngine,
    @Optional() logParser?: CompileLogAnalyzer,
    @Optional() synctexProcessor?: SyncTexProcessor,
    @Optional() wordCounter?: TexWordCounter,
    @Optional() diskUsageCleaner?: DiskUsageCleaner,
    @Optional() healthCheck?: ClsiHealthCheck,
    @Optional() pipeline?: CompilePipeline,
    @Optional() fairQueue?: CompileFairQueue,
  ) {
    this.fairQueue = fairQueue ?? new CompileFairQueue();
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
    this.workspace = workspace ?? new OverleafIncrementalWorkspace(scratchDir);

    this.remoteClient =
      remoteClient ??
      new RemoteClsiClientAdapter(this.configService, this.cache);
    this.workspacePlanner =
      workspacePlanner ??
      new ClsiWorkspacePlannerService(
        undefined,
        undefined,
        undefined,
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
    dto: CompileManuscriptDto,
    userId?: string,
    authorizedProjectId?: string,
  ): Promise<ClsiCompileResult> {
    if (!this.compileQueue) {
      throw new Error('CLSI compile queue is not initialized');
    }

    const projectId = authorizedProjectId || dto.projectId || 'default';
    const effectiveTimeoutMs = dto.timeoutMs ?? 240000;

    // Pre-compile Yjs flush in the API process before dispatching to external BullMQ worker
    if (this.realtimeService && projectId && projectId !== 'default') {
      try {
        await this.realtimeService.flushProjectBeforeCompile(projectId);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `Pre-queue Yjs flush encountered an error for project ${projectId}: ${msg}`,
        );
      }
    }

    // Cancel any previous queued BullMQ job for this project
    const existingJobId = this.activeQueueJobIds.get(projectId);
    if (existingJobId) {
      try {
        const oldJob = await this.compileQueue.getJob(existingJobId);
        if (oldJob) {
          await oldJob.remove().catch(() => {});
        }
      } catch {}
    }

    const jobId = `clsi-${projectId}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
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
    this.activeQueueJobIds.set(projectId, jobId);

    const startTime = Date.now();
    const pollIntervalMs = 200;
    try {
      while (Date.now() - startTime < effectiveTimeoutMs) {
        if (this.activeQueueJobIds.get(projectId) !== jobId) {
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
      if (this.activeQueueJobIds.get(projectId) === jobId) {
        this.activeQueueJobIds.delete(projectId);
      }
    }
  }

  public async enqueueCompile(
    dto: CompileManuscriptDto,
    userId?: string,
    authorizedProjectId?: string,
  ): Promise<{ jobId: string }> {
    if (!this.compileQueue) {
      throw new Error('CLSI compile queue is not initialized');
    }
    const projectId = authorizedProjectId || dto.projectId || 'default';
    const job = await this.compileQueue.add(
      'clsi-compile',
      { dto, userId, authorizedProjectId },
      {
        jobId: `clsi-${projectId}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
        removeOnComplete: { age: 60, count: 10 },
        removeOnFail: { age: 300, count: 25 },
      },
    );
    return { jobId: job.id! };
  }

  public async compile(
    dto: CompileManuscriptDto,
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
    dto: CompileManuscriptDto,
    _userId?: string,
    authorizedProjectId?: string,
  ): Promise<ClsiCompileResult> {
    const requestedEngine = dto.engine;
    const texLiveVersion = dto.texLiveVersion || '2025';
    const explicitDtoProjectId = dto.projectId;
    const resolvedFromDto = await this.workspacePlanner.resolveProjectId(dto);

    if (authorizedProjectId) {
      if (
        (explicitDtoProjectId &&
          explicitDtoProjectId !== authorizedProjectId) ||
        (resolvedFromDto &&
          resolvedFromDto !== 'default' &&
          resolvedFromDto !== authorizedProjectId)
      ) {
        throw new ForbiddenException({
          statusCode: 403,
          code: 'PROJECT_CONTEXT_MISMATCH',
          message: 'Authorized project context does not match compile payload',
        });
      }
    }
    const rawProjectId = authorizedProjectId || resolvedFromDto;
    const projectId =
      rawProjectId && rawProjectId !== 'default'
        ? rawProjectId
        : _userId
          ? `adhoc-${_userId}`
          : `adhoc-${crypto.randomUUID()}`;
    const effectiveTimeoutMs = dto.timeoutMs ?? 240000;
    const metricEngine = requestedEngine || 'pdflatex';

    return await this.fairQueue.schedule(
      projectId,
      _userId,
      this.realtimeService,
      async (signal, onLogChunk) => {
        if (
          this.realtimeService &&
          projectId &&
          !projectId.startsWith('adhoc-')
        ) {
          try {
            await this.realtimeService.flushProjectBeforeCompile(projectId);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            this.logger.warn(
              `Pre-compile flush barrier encountered an error for project ${projectId}: ${msg}`,
            );
          }
        }

        const plan = await this.workspacePlanner.planFiles(
          projectId.startsWith('adhoc-') ? 'default' : projectId,
          dto,
        );
        const cacheKey = `flux:clsi:compile:${this.hashSource(
          [
            projectId,
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
            await this.syncCachedArtifactsToScratch(projectId, cached);
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
          projectId,
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
        );
      },
    );
  }

  private async syncCachedArtifactsToScratch(
    projectId: string,
    result: ClsiCompileResult,
  ): Promise<void> {
    try {
      const scratchDir = await this.workspace.ensureScratch(projectId);
      const writes: Promise<void>[] = [];
      if (result.pdf) {
        writes.push(
          fs.writeFile(
            path.join(scratchDir, 'output.pdf'),
            Buffer.from(result.pdf, 'base64'),
          ),
        );
      }
      if (result.synctex) {
        writes.push(
          fs.writeFile(
            path.join(scratchDir, 'output.synctex.gz'),
            Buffer.from(result.synctex, 'base64'),
          ),
        );
      }
      if (result.logs) {
        writes.push(
          fs.writeFile(
            path.join(scratchDir, 'output.log'),
            result.logs,
            'utf8',
          ),
        );
      }
      if (writes.length > 0) {
        await Promise.allSettled(writes);
      }
    } catch {
      // Non-blocking artifact sync to local workspace scratch
    }
  }

  private async runScheduledCompile(
    projectId: string,
    plan: PlannedFileSet,
    dto: CompileManuscriptDto,
    engine: string | undefined,
    cacheKey: string,
    effectiveTimeoutMs: number,
    metricEngine: string,
    texLiveVersion: string,
    signal: AbortSignal,
    onLogChunk: (chunk: string) => void,
    _userId?: string,
  ): Promise<ClsiCompileResult> {
    const mainFile = plan.mainFile;
    const dbProjectId = projectId.startsWith('adhoc-') ? 'default' : projectId;
    const mergedFiles = await this.workspacePlanner.hydrateFiles(
      dbProjectId,
      plan,
    );
    const rawMain = mergedFiles[mainFile] ?? dto.source ?? '';
    const source = Buffer.isBuffer(rawMain)
      ? rawMain.toString('utf8')
      : rawMain;

    if (dto.forceClean) {
      await this.pipeline.runWithProjectLock(
        projectId,
        () => this.workspace.cleanScratch(projectId),
        signal,
      );
    }

    const remoteResult = await this.remoteClient.tryRemoteClsiCompile({
      projectId,
      mainFile,
      source,
      mergedFiles,
      dto,
      engine,
      cacheKey,
      signal,
    });

    if (remoteResult) {
      await this.syncCachedArtifactsToScratch(projectId, remoteResult);
    }

    const pipelineResult: CompilePipelineResult =
      remoteResult ??
      (await this.pipeline.execute({
        projectId,
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

  private async loadSynctexContent(
    projectId: string,
    inlineSynctexBase64?: string,
  ): Promise<string | null> {
    if (inlineSynctexBase64) {
      const buffer = Buffer.from(inlineSynctexBase64, 'base64');
      return await this.synctexParser.decompress(buffer);
    }

    const scratchDir = this.workspace.getScratchDir(projectId);
    for (const filename of ['output.synctex.gz', 'output.synctex']) {
      try {
        const safePath = path.join(scratchDir, filename);
        const stat = await fs.lstat(safePath);
        if (stat.isSymbolicLink() || !stat.isFile()) continue;

        const cacheKey = `${projectId}:${filename}`;
        const cached = this.synctexDiskCache.get(cacheKey);
        if (
          cached &&
          cached.mtimeMs === stat.mtimeMs &&
          cached.size === stat.size
        ) {
          return cached.content;
        }

        const buf = await this.workspace.readAuxFile(projectId, filename);
        if (!buf) continue;
        const content = filename.endsWith('.gz')
          ? await this.synctexParser.decompress(buf)
          : buf.toString('utf8');
        if (content) {
          if (this.synctexDiskCache.size >= 16) {
            const oldestKey = this.synctexDiskCache.keys().next().value;
            if (oldestKey) this.synctexDiskCache.delete(oldestKey);
          }
          this.synctexDiskCache.set(cacheKey, {
            mtimeMs: stat.mtimeMs,
            size: stat.size,
            content,
          });
          return content;
        }
      } catch {
        continue;
      }
    }

    return null;
  }

  public async forwardSync(
    dto: ForwardSyncDto,
    authorizedProjectId?: string,
  ): Promise<{
    success: boolean;
    result?: SyncPoint;
    error?: string;
  }> {
    const explicitDtoProjectId = dto.projectId;
    const resolvedFromDto = await this.workspacePlanner.resolveProjectId({
      projectId: dto.projectId,
      pageId: dto.pageId,
    });

    if (authorizedProjectId) {
      if (
        (explicitDtoProjectId &&
          explicitDtoProjectId !== authorizedProjectId) ||
        (resolvedFromDto &&
          resolvedFromDto !== 'default' &&
          resolvedFromDto !== authorizedProjectId)
      ) {
        throw new ForbiddenException({
          statusCode: 403,
          code: 'PROJECT_CONTEXT_MISMATCH',
          message: 'Authorized project context does not match synctex payload',
        });
      }
    }
    const projectId = authorizedProjectId || resolvedFromDto;

    const remoteRes = await this.remoteClient.tryRemoteForwardSync(dto);
    if (remoteRes) return remoteRes;

    const synctexContent = await this.loadSynctexContent(
      projectId,
      dto.synctex,
    );
    if (!synctexContent) {
      return {
        success: false,
        error:
          'SyncTeX data not available. Compile the manuscript first to generate SyncTeX mapping.',
      };
    }

    const point = this.synctexParser.forwardLookup(
      synctexContent,
      dto.file || 'main.tex',
      dto.line,
      dto.column,
    );

    if (!point) {
      return {
        success: false,
        error: `No PDF coordinate match found for ${dto.file || 'main.tex'}:${dto.line}`,
      };
    }

    return { success: true, result: point };
  }

  public async reverseSync(
    dto: ReverseSyncDto,
    authorizedProjectId?: string,
  ): Promise<{
    success: boolean;
    result?: ReverseSyncPoint;
    error?: string;
  }> {
    const explicitDtoProjectId = dto.projectId;
    const resolvedFromDto = await this.workspacePlanner.resolveProjectId({
      projectId: dto.projectId,
      pageId: dto.pageId,
    });

    if (authorizedProjectId) {
      if (
        (explicitDtoProjectId &&
          explicitDtoProjectId !== authorizedProjectId) ||
        (resolvedFromDto &&
          resolvedFromDto !== 'default' &&
          resolvedFromDto !== authorizedProjectId)
      ) {
        throw new ForbiddenException({
          statusCode: 403,
          code: 'PROJECT_CONTEXT_MISMATCH',
          message: 'Authorized project context does not match synctex payload',
        });
      }
    }
    const projectId = authorizedProjectId || resolvedFromDto;

    const remoteRes = await this.remoteClient.tryRemoteReverseSync(dto);
    if (remoteRes) return remoteRes;

    const synctexContent = await this.loadSynctexContent(
      projectId,
      dto.synctex,
    );
    if (!synctexContent) {
      return {
        success: false,
        error:
          'SyncTeX data not available. Compile the manuscript first to generate SyncTeX mapping.',
      };
    }

    const point = this.synctexParser.reverseLookup(
      synctexContent,
      dto.page,
      dto.x,
      dto.y,
    );

    if (!point) {
      return {
        success: false,
        error: `No source line match found at Page ${dto.page} (${dto.x}, ${dto.y})`,
      };
    }

    return { success: true, result: point };
  }

  public getWordCount(dto: ClsiWordCountDto): {
    success: boolean;
    stats?: WordCountStats;
    error?: string;
  } {
    if (!dto.source || !dto.source.trim()) {
      return {
        success: true,
        stats: {
          wordsInText: 0,
          wordsInHeaders: 0,
          wordsInCaptions: 0,
          headers: 0,
          floats: 0,
          mathInlines: 0,
          mathDisplayed: 0,
          totalWords: 0,
          charactersWithSpaces: 0,
          charactersNoSpaces: 0,
          rawOutput: 'Empty document (0 words)',
        },
      };
    }

    const stats = this.wordCounter.count(dto.source);
    return {
      success: true,
      stats,
    };
  }

  public async listAuxFiles(projectId: string) {
    const files = await this.workspace.listAuxFiles(projectId);
    return { files };
  }

  public async downloadAuxFile(
    projectId: string,
    filename: string,
    res: FastifyReply,
  ) {
    const buffer = await this.workspace.readAuxFile(projectId, filename);
    if (!buffer) {
      throw new NotFoundException(`Artifact file ${filename} not found`);
    }

    const ext = path.extname(filename).toLowerCase();
    const mimeTypes: Record<string, string> = {
      '.pdf': 'application/pdf',
      '.log': 'text/plain; charset=utf-8',
      '.aux': 'text/plain; charset=utf-8',
      '.bbl': 'text/plain; charset=utf-8',
      '.blg': 'text/plain; charset=utf-8',
      '.toc': 'text/plain; charset=utf-8',
      '.lof': 'text/plain; charset=utf-8',
      '.lot': 'text/plain; charset=utf-8',
      '.fls': 'text/plain; charset=utf-8',
      '.fdb_latexmk': 'text/plain; charset=utf-8',
      '.synctex.gz': 'application/gzip',
      '.synctex': 'text/plain; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.svg': 'image/svg+xml',
    };
    const contentType = mimeTypes[ext] || 'application/octet-stream';

    res.header(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(filename)}"`,
    );
    res.header('Content-Type', contentType);
    return res.send(buffer);
  }

  public async readAuxFileBuffer(
    projectId: string,
    filename: string,
  ): Promise<Buffer | null> {
    return await this.workspace.readAuxFile(projectId, filename);
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
  ): Promise<{ success: boolean; projectId: string }> {
    await this.pipeline.runWithProjectLock(projectId, () =>
      this.workspace.cleanScratch(projectId),
    );
    return { success: true, projectId };
  }

  public async downloadAllArtifactsZip(
    projectId: string,
    res: FastifyReply,
  ): Promise<void> {
    const scratchDir = this.workspace.getScratchDir(projectId);
    const diskEntries: ZipDiskEntry[] = [];

    const walk = async (currentDir: string, relDir: string) => {
      try {
        const dirEntries = await fs.readdir(currentDir, {
          withFileTypes: true,
        });
        for (const entry of dirEntries) {
          if (
            entry.name === '.project-lock' ||
            entry.name === '.clsi-manifest.json' ||
            entry.name === '.clsi-build-state.json' ||
            entry.name === '.latexmkrc' ||
            entry.isSymbolicLink()
          ) {
            continue;
          }
          const fullPath = path.join(currentDir, entry.name);
          const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            await walk(fullPath, relPath);
          } else if (entry.isFile()) {
            const stat = await fs.lstat(fullPath);
            if (!stat.isSymbolicLink() && stat.isFile()) {
              diskEntries.push({ fullPath, relPath, date: stat.mtime });
            }
          }
        }
      } catch {
        // Ignored
      }
    };

    await walk(scratchDir, '');

    if (diskEntries.length === 0) {
      throw new NotFoundException(
        `No output artifacts found for project ${projectId}`,
      );
    }

    const zipStream = createZipStreamFromDisk(diskEntries);
    res.header(
      'Content-Disposition',
      `attachment; filename="project-${encodeURIComponent(projectId)}-artifacts.zip"`,
    );
    res.header('Content-Type', 'application/zip');
    return res.send(zipStream);
  }
}
