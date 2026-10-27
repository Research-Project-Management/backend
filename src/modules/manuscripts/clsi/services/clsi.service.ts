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
import * as os from 'os';
import * as path from 'path';
import { RedisCacheService } from '@/core';
import {
  CompileManuscriptDto,
  ClsiWordCountDto,
  ClsiCompilerEngine,
} from '../dto/clsi.dto';
import { ForwardSyncDto, ReverseSyncDto } from '../dto/synctex.dto';
import {
  SyncPoint,
  ReverseSyncPoint,
  WordCountStats,
} from '../domain/clsi-ports';
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
  TectonicEngine,
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
  private readonly inFlightBuilds = new Map<
    string,
    Promise<ClsiCompileResult>
  >();
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
    @Optional() tectonicEngine?: TectonicEngine,
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
    const normalizedMode =
      rawMode === 'local-unsafe' || rawMode === 'local'
        ? 'local-unsafe'
        : 'container';
    const sandboxConfig = parseSandboxConfig({
      env: {
        CLSI_SANDBOX_MODE: normalizedMode,
        CLSI_SANDBOX_IMAGE:
          this.configService.get<string>('CLSI_SANDBOX_IMAGE') ||
          this.configService.get<string>('CLSI_DOCKER_IMAGE') ||
          undefined,
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
    const tectonicBin =
      this.configService.get<string>('TECTONIC_BIN') || 'tectonic';

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
      );

    // Pure in-process domain logic
    this.logParser = logParser ?? new CompileLogAnalyzer();
    this.synctexParser = synctexProcessor ?? new SyncTexProcessor();
    this.wordCounter = wordCounter ?? new TexWordCounter();

    // Workspace & Real Sandbox/Engine seams
    this.workspace = workspace ?? new OverleafIncrementalWorkspace(scratchDir);

    const needsRunner = !latexmkEngine || !tectonicEngine || !healthCheck;
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
    const resolvedTectonicEngine =
      tectonicEngine ?? new TectonicEngine(runner!, tectonicBin);

    this.diskUsageCleaner =
      diskUsageCleaner ?? new DiskUsageCleaner(scratchDir);
    this.healthCheck = healthCheck ?? new ClsiHealthCheck(runner!, scratchDir);

    this.pipeline =
      pipeline ??
      new CompilePipeline(
        this.workspace,
        resolvedLatexmkEngine,
        resolvedTectonicEngine,
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

  private normalizeCompileDto(dto: CompileManuscriptDto): void {
    if (dto.compile) {
      if (dto.compile.rootResourcePath && !dto.main_file) {
        dto.main_file = dto.compile.rootResourcePath;
      }
      if (dto.compile.options?.compiler && !dto.engine) {
        const rawCompiler =
          dto.compile.options.compiler.toLowerCase() as ClsiCompilerEngine;
        if (Object.values(ClsiCompilerEngine).includes(rawCompiler)) {
          dto.engine = rawCompiler;
        }
      }
      if (dto.compile.options?.draft !== undefined && dto.draft === undefined) {
        dto.draft = dto.compile.options.draft;
      }
      if (dto.compile.options?.timeout && !dto.timeout_ms) {
        dto.timeout_ms = dto.compile.options.timeout * 1000;
      }
      if (dto.compile.resources) {
        dto.files = dto.files || {};
        for (const res of dto.compile.resources) {
          if (res.content !== undefined) {
            dto.files[res.path] = res.content;
          }
        }
      }
    }
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

    const projectId =
      authorizedProjectId || dto.projectId || dto.project_id || 'default';
    const effectiveTimeoutMs = dto.timeout_ms ?? dto.timeoutMs ?? 240000;

    const job = await this.compileQueue.add(
      'clsi-compile',
      {
        dto,
        userId,
        authorizedProjectId,
      },
      {
        jobId: `clsi-${projectId}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
        removeOnComplete: 100,
        removeOnFail: 200,
      },
    );

    const startTime = Date.now();
    const pollIntervalMs = 200;
    while (Date.now() - startTime < effectiveTimeoutMs) {
      const state = await job.getState();
      if (state === 'completed') {
        const freshJob = await this.compileQueue.getJob(job.id!);
        return freshJob?.returnvalue as ClsiCompileResult;
      }
      if (state === 'failed') {
        const freshJob = await this.compileQueue.getJob(job.id!);
        throw new Error(
          freshJob?.failedReason || 'Job execution failed in CLSI worker',
        );
      }
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }

    throw new Error(
      `CLSI compile job ${job.id} timed out after ${effectiveTimeoutMs}ms in queue`,
    );
  }

  public async enqueueCompile(
    dto: CompileManuscriptDto,
    userId?: string,
    authorizedProjectId?: string,
  ): Promise<{ jobId: string }> {
    if (!this.compileQueue) {
      throw new Error('CLSI compile queue is not initialized');
    }
    const projectId =
      authorizedProjectId || dto.projectId || dto.project_id || 'default';
    const job = await this.compileQueue.add(
      'clsi-compile',
      { dto, userId, authorizedProjectId },
      {
        jobId: `clsi-${projectId}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
        removeOnComplete: 100,
        removeOnFail: 200,
      },
    );
    return { jobId: job.id! };
  }

  public async compile(
    dto: CompileManuscriptDto,
    userId?: string,
    authorizedProjectId?: string,
  ): Promise<ClsiCompileResult> {
    this.normalizeCompileDto(dto);

    if (await this.isQueueActive()) {
      try {
        return await this.queueCompileJob(dto, userId, authorizedProjectId);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `CLSI queue compile failed or timed out, falling back to inline fairQueue: ${msg}`,
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
    this.normalizeCompileDto(dto);

    const requestedEngine = dto.engine;
    const texLiveVersion = dto.tex_live_version || dto.texLiveVersion || '2024';
    const explicitDtoProjectId = dto.projectId || dto.project_id;
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
    const projectId = authorizedProjectId || resolvedFromDto;
    const effectiveTimeoutMs = dto.timeout_ms ?? dto.timeoutMs ?? 240000;
    const metricEngine = requestedEngine || 'pdflatex';

    return await this.fairQueue.schedule(
      projectId,
      _userId,
      this.realtimeService,
      async (signal, onLogChunk) => {
        if (this.realtimeService && projectId) {
          try {
            await this.realtimeService.flushProjectBeforeCompile(projectId);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            this.logger.warn(
              `Pre-compile flush barrier encountered an error for project ${projectId}: ${msg}`,
            );
          }
        }

        const plan = await this.workspacePlanner.planFiles(projectId, dto);
        const cacheKey = `flux:clsi:compile:${this.hashSource(
          [
            projectId,
            plan.fingerprint,
            plan.mainFile,
            requestedEngine || 'auto',
            texLiveVersion,
            dto.draft ?? false,
            dto.syntax_only ?? dto.syntaxOnly ?? false,
            dto.stopOnFirstError ?? dto.stop_on_first_error ?? false,
          ].join('|'),
        )}`;
        const cacheable = !!(dto.use_cache && plan.hasMainContent);

        if (cacheable && this.cache) {
          const cached = await this.cache.get<ClsiCompileResult>(cacheKey);
          if (cached && cached.success) {
            this.metrics.record({
              engine: metricEngine,
              durationMs: 5,
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

        if (plan.hasMainContent) {
          const existingBuild = this.inFlightBuilds.get(cacheKey);
          if (existingBuild) return existingBuild;
        }

        const build = this.runScheduledCompile(
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
        if (!plan.hasMainContent) return await build;

        const tracked = build.finally(() => {
          if (this.inFlightBuilds.get(cacheKey) === tracked) {
            this.inFlightBuilds.delete(cacheKey);
          }
        });
        this.inFlightBuilds.set(cacheKey, tracked);
        return await tracked;
      },
    );
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
    const mergedFiles = await this.workspacePlanner.hydrateFiles(
      projectId,
      plan,
    );
    const rawMain = mergedFiles[mainFile] ?? dto.source ?? '';
    const source = Buffer.isBuffer(rawMain)
      ? rawMain.toString('utf8')
      : rawMain;

    const remoteResult = await this.remoteClient.tryRemoteClsiCompile(
      projectId,
      mainFile,
      source,
      mergedFiles,
      dto,
      engine,
      cacheKey,
    );
    if (remoteResult) {
      return remoteResult;
    }

    if (dto.force_clean || dto.forceClean) {
      await this.pipeline.runWithProjectLock(projectId, () =>
        this.workspace.cleanScratch(projectId),
      );
    }

    const pipelineResult: CompilePipelineResult = await this.pipeline.execute({
      projectId,
      mainFile,
      engine,
      texLiveVersion,
      draft: dto.draft,
      syntaxOnly: dto.syntax_only ?? dto.syntaxOnly,
      stopOnFirstError:
        dto.stopOnFirstError ?? dto.stop_on_first_error ?? false,
      timeoutMs: effectiveTimeoutMs,
      source,
      files: mergedFiles,
      signal,
      onLogChunk,
    });

    this.metrics.record({
      engine: metricEngine,
      durationMs: pipelineResult.durationMs,
      success: pipelineResult.success,
      isCached: false,
      isTimeout: pipelineResult.durationMs >= effectiveTimeoutMs,
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
      );
    }

    return pipelineResult;
  }

  public cancelCompile(projectId: string): boolean {
    return this.fairQueue.cancel(projectId);
  }

  private async loadSynctexContent(
    projectId: string,
    inlineSynctexBase64?: string,
  ): Promise<string | null> {
    if (inlineSynctexBase64) {
      const buffer = Buffer.from(inlineSynctexBase64, 'base64');
      return await this.synctexParser.decompress(buffer);
    }

    const gzBuffer = await this.workspace.readAuxFile(
      projectId,
      'output.synctex.gz',
    );
    if (gzBuffer) {
      return await this.synctexParser.decompress(gzBuffer);
    }

    const plainBuffer = await this.workspace.readAuxFile(
      projectId,
      'output.synctex',
    );
    if (plainBuffer) {
      return plainBuffer.toString('utf8');
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
    const explicitDtoProjectId = dto.projectId || dto.project_id;
    const resolvedFromDto = await this.workspacePlanner.resolveProjectId({
      projectId: dto.projectId,
      project_id: dto.project_id,
      pageId: dto.pageId,
      page_id: dto.page_id,
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
    const explicitDtoProjectId = dto.projectId || dto.project_id;
    const resolvedFromDto = await this.workspacePlanner.resolveProjectId({
      projectId: dto.projectId,
      project_id: dto.project_id,
      pageId: dto.pageId,
      page_id: dto.page_id,
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
            entry.name === '.latexmkrc'
          ) {
            continue;
          }
          const fullPath = path.join(currentDir, entry.name);
          const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            await walk(fullPath, relPath);
          } else if (entry.isFile()) {
            const stat = await fs.stat(fullPath);
            diskEntries.push({ fullPath, relPath, date: stat.mtime });
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
