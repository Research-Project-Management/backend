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

export type ClsiCompileResult =
  | {
      success: true;
      pdf: string;
      synctex?: string;
      logs: string;
      diagnostics?: CompilerDiagnostic[];
      outputFiles?: DiscoveredOutputFile[];
      durationMs: number;
    }
  | {
      success: false;
      error: string;
      pdf?: string;
      synctex?: string;
      logs: string;
      diagnostics?: CompilerDiagnostic[];
      outputFiles?: DiscoveredOutputFile[];
      durationMs: number;
    };

@Injectable()
export class ClsiService {
  private readonly logger = new Logger(ClsiService.name);
  private readonly workspace: OverleafIncrementalWorkspace;
  private readonly pipeline: CompilePipeline;
  private readonly fairQueue = new CompileFairQueue();
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

    const logParser = new OverleafLogParser();
    const synctexProcessor = new SyncTexProcessor();
    const wordCounter = new TexWordCounter();

    this.diskUsageCleaner = new DiskUsageCleaner(scratchDir);
    this.healthCheck = new ClsiHealthCheck(runner, scratchDir);

    // Initialize Pipelines
    this.pipeline = new CompilePipeline(
      this.workspace,
      latexmkEngine,
      tectonicEngine,
      logParser,
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

  public async compile(
    dto: CompileManuscriptDto,
    _userId?: string,
  ): Promise<ClsiCompileResult> {
    const projectId = dto.projectId || dto.project_id || 'default';
    const mainFile = dto.main_file || 'main.tex';
    let source = dto.source || '';
    const files = dto.files || {};
    const engine = dto.engine || 'pdflatex';

    // Auto-fetch source from Docstore / Prisma if not provided
    if (!source && (dto.pageId || dto.page_id) && this.prisma) {
      const pageId = (dto.pageId || dto.page_id)!;
      try {
        const record = await this.prisma.manuscriptDoc.findUnique({
          where: { id: pageId },
        });
        if (record && record.lines) {
          source = Array.isArray(record.lines)
            ? (record.lines as string[]).join('\n')
            : String(record.lines);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.debug(`Could not auto-fetch page ${pageId}: ${msg}`);
      }
    }

    const sourceHash = this.hashSource(
      `${source}:${JSON.stringify(files)}:${engine}:${dto.draft ?? false}`,
    );
    const cacheKey = `flux:clsi:compile:${sourceHash}`;

    // 1. Check Redis Cache
    if (dto.use_cache && this.cache && source) {
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

    // 2. Dispatch to Standalone CLSI Microservice if configured
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
                source,
                files,
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
          const rawResult = (await response.json()) as ClsiCompileResult & {
            timing?: { totalMs?: number };
          };
          const result: ClsiCompileResult = {
            ...rawResult,
            durationMs: rawResult.durationMs ?? rawResult.timing?.totalMs ?? 0,
          };
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

    // 3. Execute compilation through Fair-Queue single-flight pipeline
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
            files,
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

        // 4. Cache successful results (5 mins TTL, max 2MB base64)
        if (
          pipelineResult.success &&
          this.cache &&
          pipelineResult.pdf &&
          pipelineResult.pdf.length <= 2 * 1024 * 1024
        ) {
          await this.cache.set(cacheKey, pipelineResult, 300);
        }

        // 5. Broadcast live compile completion status over WebSocket
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
