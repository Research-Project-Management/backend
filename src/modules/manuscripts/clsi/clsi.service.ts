/**
 * modules/manuscripts/clsi/clsi.service.ts
 * NestJS Injectable service orchestrating CLSI compile operations,
 * caching, and SyncTeX coordinate resolution.
 */

import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FastifyReply } from 'fastify';
import * as crypto from 'crypto';
import { RedisCacheService } from '@/core/cache/redis.service';
import { PrismaService } from '@/core/database/prisma.service';
import { CompileManuscriptDto, ClsiWordCountDto } from './dto/clsi.dto';
import { ForwardSyncDto, ReverseSyncDto } from './dto/synctex.dto';
import {
  SyncPoint,
  ReverseSyncPoint,
  CompilerDiagnostic,
  DiscoveredOutputFile,
} from './core/ports/artifacts.port';
import { OverleafIncrementalWorkspace } from './core/adapters/workspace/incremental-workspace';
import { LocalProcessRunner } from './core/adapters/runners/local-process.runner';
import { DockerSandboxRunner } from './core/adapters/runners/docker-sandbox.runner';
import { LatexmkEngine } from './core/adapters/engines/latexmk.engine';
import { TectonicEngine } from './core/adapters/engines/tectonic.engine';
import { OverleafLogParser } from './core/adapters/artifacts/latex-log.parser';
import { SyncTexProcessor } from './core/adapters/artifacts/synctex.processor';
import { TexWordCounter } from './core/adapters/artifacts/word-counter';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  CompilePipeline,
  CompilePipelineResult,
} from './core/pipeline/compile-pipeline';
import { CompileFairQueue } from './core/pipeline/compile-fair-queue';
import {
  planDbFileSet,
  planInlineFileSet,
  linesToText,
  PlannedFileSet,
} from './core/pipeline/compile-fileset';
import { SyncTexUseCase } from './core/pipeline/synctex.use-case';
import { WordCountUseCase } from './core/pipeline/word-count.use-case';
import {
  DiskUsageCleaner,
  DiskUsageOptions,
} from './core/adapters/workspace/disk-usage.cleaner';
import { ClsiHealthCheck } from './core/adapters/engines/health-check';
import { ClsiMetrics } from './core/adapters/telemetry/clsi.metrics';
import {
  buildZipArchive,
  ZipFileEntry,
} from './core/adapters/artifacts/zip.util';
import { RealtimeService } from '@/modules/realtime/realtime.service';

export type ClsiCompileResult = CompilePipelineResult;

@Injectable()
export class ClsiService {
  private readonly logger = new Logger(ClsiService.name);
  private readonly workspace: OverleafIncrementalWorkspace;
  private readonly pipeline: CompilePipeline;
  private readonly logParser = new OverleafLogParser();
  private readonly fairQueue = new CompileFairQueue();
  private readonly inFlightBuilds = new Map<
    string,
    Promise<ClsiCompileResult>
  >();
  private readonly synctexUseCase: SyncTexUseCase;
  private readonly wordCountUseCase: WordCountUseCase;
  private readonly diskUsageCleaner: DiskUsageCleaner;
  private readonly healthCheck: ClsiHealthCheck;
  private readonly metrics: ClsiMetrics = ClsiMetrics.getInstance();
  private readonly remoteClsiUrl?: string;

  constructor(
    private readonly configService: ConfigService,
    @Optional() private readonly cache?: RedisCacheService,
    @Optional() private readonly realtimeService?: RealtimeService,
    @Optional() private readonly prisma?: PrismaService,
  ) {
    const scratchDir =
      this.configService.get<string>('SCRATCH_DIR') || '/tmp/clsi-scratch';
    const useDocker =
      this.configService.get<string>('USE_DOCKER_SANDBOX') === 'true';
    const dockerImage =
      this.configService.get<string>('DOCKER_IMAGE') ||
      'sharelatex/clsi:latest';
    const latexmkBin =
      this.configService.get<string>('LATEXMK_BIN') || 'latexmk';
    const tectonicBin =
      this.configService.get<string>('TECTONIC_BIN') || 'tectonic';

    this.remoteClsiUrl =
      this.configService.get<string>('CLSI_URL') || 'http://localhost:3013';

    // Initialize Hexagonal Adapters
    this.workspace = new OverleafIncrementalWorkspace(scratchDir);
    const runner = useDocker
      ? new DockerSandboxRunner(dockerImage)
      : new LocalProcessRunner();

    const latexmkEngine = new LatexmkEngine(runner, latexmkBin, 'pdflatex');
    const tectonicEngine = new TectonicEngine(runner, tectonicBin);

    const synctexProcessor = new SyncTexProcessor();
    const wordCounter = new TexWordCounter();

    this.diskUsageCleaner = new DiskUsageCleaner(scratchDir);
    this.healthCheck = new ClsiHealthCheck(runner, scratchDir);

    // Initialize Pipelines
    this.pipeline = new CompilePipeline(
      this.workspace,
      latexmkEngine,
      tectonicEngine,
      this.logParser,
    );
    this.synctexUseCase = new SyncTexUseCase(this.workspace, synctexProcessor);
    this.wordCountUseCase = new WordCountUseCase(wordCounter);
  }

  private hashSource(source: string): string {
    return crypto
      .createHash('sha256')
      .update(source || '')
      .digest('hex');
  }

  /**
   * Resolve the owning project when only a page/doc id was supplied.
   */
  private async resolveProjectId(dto: CompileManuscriptDto): Promise<string> {
    const projectId = dto.projectId || dto.project_id || '';
    if (projectId) return projectId;

    const pageId = dto.pageId || dto.page_id;
    if (pageId && this.prisma) {
      try {
        const pageDoc = await this.prisma.manuscriptDoc.findUnique({
          where: { id: pageId },
          select: { projectId: true },
        });
        if (pageDoc?.projectId) return pageDoc.projectId;
      } catch {
        /* fall through to default project */
      }
    }
    return 'default';
  }

  /**
   * Plans the compile file set from lightweight metadata (no document bodies are read),
   * so the cache can be consulted before any heavy I/O happens.
   */
  private async planFiles(
    projectId: string,
    dto: CompileManuscriptDto,
  ): Promise<PlannedFileSet> {
    const incomingFiles = { ...(dto.files || {}) };
    const mainFile = dto.main_file || 'main.tex';
    const source = dto.source || '';

    if (this.prisma && projectId !== 'default') {
      try {
        const [nodes, docs] = await Promise.all([
          this.prisma.manuscriptNode.findMany({
            where: { projectId },
            orderBy: { sortOrder: 'asc' },
            select: {
              id: true,
              docId: true,
              path: true,
              name: true,
              type: true,
              isRootDoc: true,
            },
          }),
          this.prisma.manuscriptDoc.findMany({
            where: { projectId, deleted: false },
            select: {
              id: true,
              path: true,
              rev: true,
              sizeBytes: true,
              updatedAt: true,
              inStorage: true,
            },
          }),
        ]);
        return planDbFileSet({
          nodes,
          docs,
          incomingFiles,
          source,
          mainFile,
          pageId: dto.pageId || dto.page_id,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `Could not load project documents from database: ${msg}`,
        );
      }
    }
    return planInlineFileSet({ incomingFiles, source, mainFile });
  }

  /**
   * Loads document bodies for DB-backed entries in ONE `id IN (…)` query. Only called on a
   * cache miss; inline (client-supplied) entries are used as-is.
   */
  private async hydrateFiles(
    plan: PlannedFileSet,
  ): Promise<Record<string, string>> {
    const dbIds: string[] = [];
    let archivedWithContent = 0;
    for (const s of plan.files.values()) {
      if (s.kind !== 'db') continue;
      dbIds.push(s.docId);
      if (s.inStorage && s.sizeBytes > 0) archivedWithContent++;
    }
    if (archivedWithContent > 0) {
      this.logger.warn(
        `${archivedWithContent} cold-storage doc(s) have no inline body; compiling them as empty. Unarchive before compiling.`,
      );
    }

    const contentById = new Map<string, string>();
    if (dbIds.length > 0 && this.prisma) {
      const rows = await this.prisma.manuscriptDoc.findMany({
        where: { id: { in: dbIds } },
        select: { id: true, lines: true },
      });
      for (const row of rows) contentById.set(row.id, linesToText(row.lines));
    }

    const out: Record<string, string> = {};
    for (const [filePath, s] of plan.files) {
      out[filePath] =
        s.kind === 'inline' ? s.content : (contentById.get(s.docId) ?? '');
    }
    return out;
  }

  public async compile(
    dto: CompileManuscriptDto,
    _userId?: string,
  ): Promise<ClsiCompileResult> {
    // Normalize official Overleaf CLSI request envelope if provided
    if (dto.compile) {
      if (dto.compile.rootResourcePath && !dto.main_file) {
        dto.main_file = dto.compile.rootResourcePath;
      }
      if (dto.compile.options?.compiler && !dto.engine) {
        dto.engine = dto.compile.options.compiler as any;
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

    const engine = dto.engine || 'pdflatex';
    const projectId = await this.resolveProjectId(dto);

    // Phase A — metadata only: plan the file set + content-independent fingerprint.
    const plan = await this.planFiles(projectId, dto);
    const cacheKey = `flux:clsi:compile:${this.hashSource(
      [
        projectId,
        plan.fingerprint,
        plan.mainFile,
        engine,
        dto.draft ?? false,
        dto.syntax_only ?? dto.syntaxOnly ?? false,
        dto.stop_on_first_error ?? false,
      ].join('|'),
    )}`;
    const cacheable = !!(dto.use_cache && plan.hasMainContent);

    // 1. Redis cache (consulted BEFORE any document body is loaded)
    if (cacheable && this.cache) {
      const cached = await this.cache.get<ClsiCompileResult>(cacheKey);
      if (cached && cached.success) {
        this.metrics.record({
          engine,
          durationMs: 5,
          success: true,
          isCached: true,
          isTimeout: false,
          pdfSizeBytes: cached.pdf
            ? Buffer.from(cached.pdf, 'base64').length
            : 0,
        });
        return cached;
      }
    }

    // 2. Request coalescing (thundering herd): identical concurrent requests — e.g. several
    //    collaborators hitting "Recompile" on the same revision — share one build.
    if (cacheable) {
      const inFlight = this.inFlightBuilds.get(cacheKey);
      if (inFlight) return inFlight;
    }

    const build = this.runCompile(
      projectId,
      plan,
      dto,
      engine,
      cacheKey,
      _userId,
    );
    if (!cacheable) return build;

    const tracked = build.finally(() => {
      if (this.inFlightBuilds.get(cacheKey) === tracked) {
        this.inFlightBuilds.delete(cacheKey);
      }
    });
    this.inFlightBuilds.set(cacheKey, tracked);
    return tracked;
  }

  private async runCompile(
    projectId: string,
    plan: PlannedFileSet,
    dto: CompileManuscriptDto,
    engine: string,
    cacheKey: string,
    _userId?: string,
  ): Promise<ClsiCompileResult> {
    // Phase B — cache miss: now (and only now) read the document bodies.
    const mainFile = plan.mainFile;
    const mergedFiles = await this.hydrateFiles(plan);
    const source = mergedFiles[mainFile] ?? dto.source ?? '';

    // 3. Dispatch to Standalone CLSI Microservice if configured
    if (this.remoteClsiUrl) {
      try {
        const baseUrl = this.remoteClsiUrl.replace(/\/+$/, '');
        // Support Overleaf-parity CLSI routes (/api/clsi/compile, /project/:id/compile, /compile)
        const endpoints = baseUrl.endsWith('/api/clsi')
          ? [`${baseUrl}/compile`]
          : [
              `${baseUrl}/api/clsi/compile`,
              `${baseUrl}/project/${projectId}/compile`,
              `${baseUrl}/compile`,
            ];

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
                files: mergedFiles,
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
            lastError = err instanceof Error ? err : new Error(String(err));
          }
        }

        if (response && response.ok) {
          const rawResult = (await response.json()) as any;
          let result: ClsiCompileResult;

          if (rawResult?.compile?.status) {
            const isSuccess = rawResult.compile.status === 'success';
            const outputFiles: any[] = rawResult.compile.outputFiles || [];
            const pdfEntry = outputFiles.find(
              (f: any) => f.type === 'pdf' || f.path === 'output.pdf',
            );
            const logEntry = outputFiles.find(
              (f: any) => f.type === 'log' || f.path === 'output.log',
            );
            const synctexEntry = outputFiles.find(
              (f: any) =>
                f.type === 'synctex.gz' ||
                f.type === 'synctex' ||
                f.path?.includes('synctex'),
            );

            let pdfBase64 = '';
            let logsText = '';
            let synctexBase64 = '';

            if (pdfEntry?.url) {
              try {
                const fullUrl = pdfEntry.url.startsWith('http')
                  ? pdfEntry.url
                  : `${baseUrl}${pdfEntry.url}`;
                const pdfRes = await fetch(fullUrl);
                if (pdfRes.ok) {
                  const buf = await pdfRes.arrayBuffer();
                  pdfBase64 = Buffer.from(buf).toString('base64');
                }
              } catch {}
            }
            if (logEntry?.url) {
              try {
                const fullUrl = logEntry.url.startsWith('http')
                  ? logEntry.url
                  : `${baseUrl}${logEntry.url}`;
                const logRes = await fetch(fullUrl);
                if (logRes.ok) {
                  logsText = await logRes.text();
                }
              } catch {}
            }
            if (synctexEntry?.url) {
              try {
                const fullUrl = synctexEntry.url.startsWith('http')
                  ? synctexEntry.url
                  : `${baseUrl}${synctexEntry.url}`;
                const synctexRes = await fetch(fullUrl);
                if (synctexRes.ok) {
                  const buf = await synctexRes.arrayBuffer();
                  synctexBase64 = Buffer.from(buf).toString('base64');
                }
              } catch {}
            }

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
                  diagnostics.find((d: any) => d.severity === 'error')
                    ?.message || 'LaTeX compilation failed to produce a PDF',
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
              durationMs:
                rawResult.durationMs ?? rawResult.timing?.totalMs ?? 0,
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
          return result;
        }
        if (response) {
          this.logger.warn(
            `Remote CLSI responded with HTTP ${response.status}. Falling back to local pipeline.`,
          );
        } else if (lastError) {
          this.logger.warn(
            `Remote CLSI compile failed: ${lastError.message}. Falling back to local pipeline.`,
          );
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `Remote CLSI compile failed: ${msg}. Falling back to local pipeline.`,
        );
      }
    }

    // 4. Force clean scratch workspace if requested (Overleaf "Clear cached files" parity)
    if (dto.force_clean || dto.forceClean) {
      await this.workspace.cleanScratch(projectId);
    }

    // 5. Execute compilation through Fair-Queue single-flight pipeline
    const effectiveTimeoutMs = dto.timeout_ms ?? dto.timeoutMs ?? 240000;
    return await this.fairQueue.schedule(
      projectId,
      _userId,
      this.realtimeService,
      async (signal, onLogChunk) => {
        const pipelineResult: CompilePipelineResult =
          await this.pipeline.execute({
            projectId,
            mainFile,
            engine,
            draft: dto.draft,
            syntaxOnly: dto.syntax_only ?? dto.syntaxOnly,
            stopOnFirstError: dto.stop_on_first_error,
            timeoutMs: effectiveTimeoutMs,
            source,
            files: mergedFiles,
            signal,
            onLogChunk,
          });

        this.metrics.record({
          engine,
          durationMs: pipelineResult.durationMs,
          success: pipelineResult.success,
          isCached: false,
          isTimeout: pipelineResult.durationMs >= effectiveTimeoutMs,
          pdfSizeBytes: pipelineResult.pdf
            ? Buffer.from(pipelineResult.pdf, 'base64').length
            : 0,
        });

        // 5. Cache successful results (5 mins TTL, max 2MB base64)
        if (
          pipelineResult.success &&
          this.cache &&
          pipelineResult.pdf &&
          pipelineResult.pdf.length <= 2 * 1024 * 1024
        ) {
          await this.cache.set(cacheKey, pipelineResult, 300);
        }

        // 6. Broadcast live compile completion status over WebSocket
        this.realtimeService?.broadcastCompileProgress(projectId, {
          status: pipelineResult.success ? 'success' : 'failed',
          logs: pipelineResult.logs ? [pipelineResult.logs] : [],
        });

        return pipelineResult;
      },
    );
  }

  public cancelCompile(projectId: string): boolean {
    return this.fairQueue.cancel(projectId);
  }

  public async forwardSync(dto: ForwardSyncDto): Promise<{
    success: boolean;
    result?: SyncPoint;
    error?: string;
  }> {
    if (this.remoteClsiUrl) {
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
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `Remote CLSI forwardSync failed: ${msg}. Falling back to local.`,
        );
      }
    }

    return this.synctexUseCase.forwardSync({
      projectId: dto.projectId || dto.pageId || 'default',
      file: dto.file,
      line: dto.line,
      column: dto.column,
      synctex: dto.synctex,
    });
  }

  public async reverseSync(dto: ReverseSyncDto): Promise<{
    success: boolean;
    result?: ReverseSyncPoint;
    error?: string;
  }> {
    if (this.remoteClsiUrl) {
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
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `Remote CLSI reverseSync failed: ${msg}. Falling back to local.`,
        );
      }
    }

    return this.synctexUseCase.reverseSync({
      projectId: dto.projectId || dto.pageId || 'default',
      page: dto.page,
      x: dto.x,
      y: dto.y,
      synctex: dto.synctex,
    });
  }

  public getWordCount(dto: ClsiWordCountDto) {
    return this.wordCountUseCase.execute(dto.source);
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

    res.header(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(filename)}"`,
    );
    res.header('Content-Type', 'text/plain');
    res.send(buffer);
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
    await this.workspace.cleanScratch(projectId);
    return { success: true, projectId };
  }

  public async downloadAllArtifactsZip(
    projectId: string,
    res: FastifyReply,
  ): Promise<void> {
    const scratchDir = this.workspace.getScratchDir(projectId);
    const entries: ZipFileEntry[] = [];

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
            const data = await fs.readFile(fullPath);
            const stat = await fs.stat(fullPath);
            entries.push({ path: relPath, data, date: stat.mtime });
          }
        }
      } catch {
        // Ignored
      }
    };

    await walk(scratchDir, '');

    if (entries.length === 0) {
      throw new NotFoundException(
        `No output artifacts found for project ${projectId}`,
      );
    }

    const zipBuffer = buildZipArchive(entries);
    res.header(
      'Content-Disposition',
      `attachment; filename="project-${encodeURIComponent(projectId)}-artifacts.zip"`,
    );
    res.header('Content-Type', 'application/zip');
    res.send(zipBuffer);
  }
}
