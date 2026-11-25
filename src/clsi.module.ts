/**
 * clsi.module.ts
 * Dedicated NestJS module & controller for the CLSI LaTeX compilation microservice.
 * Operates in an isolated TeX Live container without database or Redis dependencies,
 * reusing the canonical domain and pipeline engines from modules/pages/clsi.
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Injectable,
  Logger,
  Module,
  NotFoundException,
  OnModuleDestroy,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { FastifyReply } from 'fastify';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  AlreadyCompilingError,
  AutoCompileShedError,
  CompileSupersededError,
  TooManyCompileRequestsError,
} from './modules/pages/clsi/domain/errors';
import {
  assessLiveCompileCapacity,
  resolveHardwareCompileConcurrencyLimit,
} from './modules/pages/clsi/services/compile-lock.service';
import {
  CompilePageDto,
  ClsiWordCountDto,
} from './modules/pages/clsi/dto/compile.dto';
import {
  ForwardSyncDto,
  ReverseSyncDto,
} from './modules/pages/clsi/dto/synctex.dto';
import { ClsiRepository } from './modules/pages/clsi/clsi.repository';
import { DiskUsageCleaner } from './modules/pages/clsi/adapters/scratch-disk.adapter';
import {
  createZipStreamFromDisk,
  ZipDiskEntry,
} from './modules/pages/clsi/services/output.service';
import { CompileService } from './modules/pages/clsi/services/compile.service';
import { LocalProcessRunner } from './modules/pages/clsi/sandbox/local.sandbox';
import { LatexmkEngine } from './modules/pages/clsi/adapters/latexmk.adapter';
import { ClsiHealthCheck } from './modules/pages/clsi/adapters/health.adapter';
import { CompileLogParser } from './modules/pages/clsi/domain/log-parser/tex-log.parser';
import { SynctexParser } from './modules/pages/clsi/domain/synctex.parser';
import { TexWordCounter } from './modules/pages/clsi/domain/word-count.engine';
import { ClsiMetrics } from './modules/pages/clsi/adapters/metrics.adapter';

interface ClsiContainerInFlightSession {
  abortController: AbortController;
  settled: Promise<void>;
}

@Injectable()
export class ClsiService implements OnModuleDestroy {
  private readonly logger = new Logger(ClsiService.name);
  private readonly workspace: ClsiRepository;
  private readonly pipeline: CompileService;
  private readonly synctexParser: SynctexParser;
  private readonly wordCounter: TexWordCounter;
  private readonly diskUsageCleaner: DiskUsageCleaner;
  private readonly healthCheck: ClsiHealthCheck;
  private readonly metrics = new ClsiMetrics();
  private readonly compileConcurrencyLimit: number;
  private readonly autoShedThreshold: number;
  private readonly supersedeGraceMs = 3000;
  private readonly inFlightCompiles = new Map<
    string,
    ClsiContainerInFlightSession
  >();

  constructor() {
    const scratchDir =
      process.env.CLSI_SCRATCH_DIR ||
      process.env.SCRATCH_DIR ||
      '/tmp/clsi-scratch';
    const latexmkBin = process.env.LATEXMK_BIN || 'latexmk';

    const maxConcurrentEnv = Number(process.env.CLSI_MAX_CONCURRENT_COMPILES);
    this.compileConcurrencyLimit =
      Number.isFinite(maxConcurrentEnv) && maxConcurrentEnv >= 1
        ? Math.floor(maxConcurrentEnv)
        : resolveHardwareCompileConcurrencyLimit({ isRemoteProxy: false });
    this.autoShedThreshold = Math.max(
      1,
      Math.floor(this.compileConcurrencyLimit * 0.75),
    );

    this.workspace = new ClsiRepository(scratchDir);
    const runner = new LocalProcessRunner();
    const latexmkEngine = new LatexmkEngine(runner, latexmkBin, 'pdflatex');
    const logParser = new CompileLogParser();

    this.synctexParser = new SynctexParser();
    this.wordCounter = new TexWordCounter();
    this.diskUsageCleaner = new DiskUsageCleaner(scratchDir);
    this.healthCheck = new ClsiHealthCheck(runner, scratchDir);
    this.pipeline = new CompileService(
      this.workspace,
      latexmkEngine,
      logParser,
    );
  }

  public onModuleDestroy(): void {
    for (const session of this.inFlightCompiles.values()) {
      session.abortController.abort();
    }
    this.inFlightCompiles.clear();
  }

  private async waitSettled(
    settled: Promise<void>,
    graceMs: number,
  ): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        settled,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, graceMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  public cancelCompile(spaceId: string): boolean {
    const session = this.inFlightCompiles.get(spaceId);
    if (session) {
      session.abortController.abort();
      this.logger.log(
        `Cancelled in-flight compilation for project "${spaceId}"`,
      );
      return true;
    }
    return false;
  }

  public async compile(dto: CompilePageDto) {
    const spaceId = dto.pageId || dto.spaceId || 'default';
    const mainFile = dto.mainFile || 'main.tex';
    const source = dto.source || '';
    const files = dto.files || {};
    const requestedEngine = dto.engine;
    const effectiveTimeoutMs = dto.timeoutMs ?? 240000;

    const existing = this.inFlightCompiles.get(spaceId);
    if (existing) {
      if (dto.forceClean) {
        existing.abortController.abort();
        await this.waitSettled(existing.settled, this.supersedeGraceMs);
      } else {
        throw new AlreadyCompilingError('compile in progress');
      }
    }

    const activeCount = this.inFlightCompiles.size;
    if (dto.priority === 'auto' && activeCount >= this.autoShedThreshold) {
      throw new AutoCompileShedError(activeCount, this.autoShedThreshold);
    }

    if (activeCount >= this.compileConcurrencyLimit) {
      throw new TooManyCompileRequestsError(
        'too many concurrent compile requests',
      );
    }

    if (activeCount >= 1) {
      const liveCapacity = assessLiveCompileCapacity({ isRemoteProxy: false });
      if (!liveCapacity.hasLiveMemoryHeadroom) {
        throw new TooManyCompileRequestsError(
          'too many concurrent compile requests',
        );
      }
    }

    const abortController = new AbortController();
    let markSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      markSettled = resolve;
    });
    const session: ClsiContainerInFlightSession = {
      abortController,
      settled,
    };
    this.inFlightCompiles.set(spaceId, session);

    try {
      if (abortController.signal.aborted) {
        throw new CompileSupersededError();
      }

      if (dto.forceClean) {
        await this.pipeline.runWithWorkspaceLock(
          spaceId,
          () => this.workspace.cleanScratch(spaceId),
          abortController.signal,
        );
      }

      this.logger.log(
        `Compiling project ${spaceId} using engine ${requestedEngine || 'auto'}`,
      );

      const pipelineResult = await this.pipeline.execute({
        spaceId,
        mainFile,
        engine: requestedEngine,
        texLiveVersion: dto.texLiveVersion || '2025',
        draft: dto.draft,
        syntaxOnly: dto.syntaxOnly,
        force: dto.forceClean,
        stopOnFirstError: dto.stopOnFirstError ?? false,
        timeoutMs: effectiveTimeoutMs,
        source,
        files,
        signal: abortController.signal,
      });

      this.metrics.record({
        engine: requestedEngine || 'pdflatex',
        durationMs: pipelineResult.durationMs,
        success: pipelineResult.success,
        isCached: false,
        isTimeout: Boolean(pipelineResult.timedOut),
        pdfSizeBytes: pipelineResult.pdf
          ? Buffer.byteLength(pipelineResult.pdf, 'base64')
          : 0,
      });

      return pipelineResult;
    } finally {
      if (this.inFlightCompiles.get(spaceId) === session) {
        this.inFlightCompiles.delete(spaceId);
      }
      markSettled();
    }
  }

  private async loadSynctexContent(
    spaceId: string,
    inlineSynctexBase64?: string,
  ): Promise<string | null> {
    if (inlineSynctexBase64) {
      const buffer = Buffer.from(inlineSynctexBase64, 'base64');
      return await this.synctexParser.decompress(buffer);
    }

    for (const filename of ['output.synctex.gz', 'output.synctex']) {
      try {
        const buf = await this.workspace.readAuxFile(spaceId, filename);
        if (!buf) continue;

        const content = filename.endsWith('.gz')
          ? await this.synctexParser.decompress(buf)
          : buf.toString('utf8');

        if (content) return content;
      } catch {
        continue;
      }
    }
    return null;
  }

  public async forwardSync(dto: ForwardSyncDto) {
    const spaceId = dto.pageId || dto.spaceId || 'default';
    const synctexContent = await this.loadSynctexContent(
      spaceId,
      dto.synctex,
    );
    if (!synctexContent) {
      return {
        success: false,
        error:
          'SyncTeX data not available. Compile the document first to generate SyncTeX mapping.',
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

  public async reverseSync(dto: ReverseSyncDto) {
    const spaceId = dto.pageId || dto.spaceId || 'default';
    const synctexContent = await this.loadSynctexContent(
      spaceId,
      dto.synctex,
    );
    if (!synctexContent) {
      return {
        success: false,
        error:
          'SyncTeX data not available. Compile the document first to generate SyncTeX mapping.',
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

  public getWordCount(dto: ClsiWordCountDto) {
    if (dto.files && Object.keys(dto.files).length > 0 && !dto.source) {
      return {
        success: true,
        stats: this.wordCounter.countProject(dto.files, {
          rootFile: dto.filename || 'main.tex',
          includeBib: dto.includeBib,
        }),
      };
    }

    if (!dto.source || !dto.source.trim()) {
      return {
        success: true,
        stats: {
          wordsInText: 0,
          wordsInHeaders: 0,
          wordsInCaptions: 0,
          wordsInBibliography: 0,
          headers: 0,
          floats: 0,
          mathInlines: 0,
          mathDisplayed: 0,
          totalWords: 0,
          charactersWithSpaces: 0,
          charactersNoSpaces: 0,
          cjkCharacters: 0,
          readingTimeMinutes: 0,
          sections: [],
          rawOutput: 'Empty document (0 words)',
        },
      };
    }

    return {
      success: true,
      stats: this.wordCounter.count(
        dto.source,
        dto.filename || 'document.tex',
        { includeBib: dto.includeBib },
      ),
    };
  }

  public async listAuxFiles(spaceId: string) {
    const files = await this.workspace.listAuxFiles(spaceId);
    return { files };
  }

  public async downloadAuxFile(
    spaceId: string,
    filename: string,
    res: FastifyReply,
  ) {
    const buffer = await this.workspace.readAuxFile(spaceId, filename);
    if (!buffer) {
      throw new NotFoundException(`Artifact file ${filename} not found`);
    }

    const lower = filename.toLowerCase();
    const ext = path.extname(lower);
    let contentType = 'application/octet-stream';
    if (lower.endsWith('.synctex.gz')) {
      contentType = 'application/gzip';
    } else if (ext === '.pdf') {
      contentType = 'application/pdf';
    } else if (
      [
        '.log',
        '.aux',
        '.bbl',
        '.blg',
        '.toc',
        '.lof',
        '.lot',
        '.fls',
        '.fdb_latexmk',
        '.synctex',
      ].includes(ext)
    ) {
      contentType = 'text/plain; charset=utf-8';
    }

    res.header(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(filename)}"`,
    );
    res.header('Content-Type', contentType);
    return res.send(buffer);
  }

  public async cleanWorkspaceScratch(
    spaceId: string,
  ): Promise<{ success: boolean; spaceId: string }> {
    await this.pipeline.runWithWorkspaceLock(spaceId, () =>
      this.workspace.cleanScratch(spaceId),
    );
    return { success: true, spaceId };
  }

  public async downloadAllArtifactsZip(spaceId: string, res: FastifyReply) {
    const scratchDir = this.workspace.getScratchDir(spaceId);
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
        // scratch may not exist yet or was cleaned
      }
    };

    await walk(scratchDir, '');

    if (diskEntries.length === 0) {
      throw new NotFoundException(
        `No output artifacts found for project ${spaceId}`,
      );
    }

    const zipStream = createZipStreamFromDisk(diskEntries);
    res.header(
      'Content-Disposition',
      `attachment; filename="project-${encodeURIComponent(spaceId)}-artifacts.zip"`,
    );
    res.header('Content-Type', 'application/zip');
    return res.send(zipStream);
  }

  public async getHealthReport() {
    const report = await this.healthCheck.checkHealth();
    return {
      ...report,
      queue: {
        capacity: this.compileConcurrencyLimit,
        active: this.inFlightCompiles.size,
        waiting: 0,
        waitingTenants: 0,
        inFlightProjects: this.inFlightCompiles.size,
      },
    };
  }

  public getMetricsSummary() {
    return this.metrics.getSummary();
  }

  public getPrometheusMetrics() {
    return this.metrics.toPrometheus();
  }

  public async cleanScratch() {
    const staleStats = await this.diskUsageCleaner.cleanStaleWorkspaces();
    const quotaStats = await this.diskUsageCleaner.enforceDiskQuota();
    return { staleStats, quotaStats };
  }
}

@ApiTags('CLSI Compilation Engine')
@Controller()
export class ClsiController {
  private readonly logger = new Logger(ClsiController.name);

  constructor(private readonly clsiService: ClsiService) {}

  @Post('compile')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Compile LaTeX source to PDF',
  })
  @ApiResponse({
    status: 200,
    description: 'Compilation finished (success or compiler error with logs)',
  })
  public async compile(
    @Body() dto: CompilePageDto,
    @Headers('x-request-id') requestId?: string,
  ) {
    const reqTag = requestId ? `[req:${requestId}] ` : '';
    try {
      return await this.clsiService.compile(dto);
    } catch (err: unknown) {
      this.logger.warn(
        `${reqTag}Compile failed for ${dto.pageId || dto.spaceId || 'adhoc'}: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
  }

  @Post('cancel/:spaceId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancel an ongoing compilation for a project',
  })
  public cancelCompile(@Param('spaceId') spaceId: string) {
    const cancelled = this.clsiService.cancelCompile(spaceId);
    return { success: true, cancelled };
  }

  @Post('word-count')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Calculate academic word count and section metrics',
  })
  public async wordCount(@Body() dto: ClsiWordCountDto) {
    return this.clsiService.getWordCount(dto);
  }

  @Post('synctex/forward')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Forward SyncTeX: map LaTeX source line/column to PDF coordinates',
  })
  public async forwardSync(@Body() dto: ForwardSyncDto) {
    return this.clsiService.forwardSync(dto);
  }

  @Post('synctex/reverse')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Reverse SyncTeX: map clicked PDF coordinates to LaTeX line/column',
  })
  public async reverseSync(@Body() dto: ReverseSyncDto) {
    return this.clsiService.reverseSync(dto);
  }

  @Get('artifacts/:spaceId')
  @ApiOperation({
    summary: 'List auxiliary build files generated by compilation',
  })
  public async listAuxFiles(@Param('spaceId') spaceId: string) {
    return this.clsiService.listAuxFiles(spaceId);
  }

  @Get('artifacts/:spaceId/:filename')
  @ApiOperation({ summary: 'Download a specific auxiliary file' })
  public async downloadAuxFile(
    @Param('spaceId') spaceId: string,
    @Param('filename') filename: string,
    @Res() res: FastifyReply,
  ) {
    return this.clsiService.downloadAuxFile(spaceId, filename, res);
  }

  @Delete('artifacts/:spaceId')
  @ApiOperation({ summary: 'Clean scratch workspace for a space or page' })
  public async cleanWorkspaceScratch(@Param('spaceId') spaceId: string) {
    return this.clsiService.cleanWorkspaceScratch(spaceId);
  }

  @Get('artifacts-zip/:spaceId')
  @ApiOperation({
    summary: 'Download all project output artifacts packaged as a ZIP archive',
  })
  public async downloadAllArtifactsZip(
    @Param('spaceId') spaceId: string,
    @Res() res: FastifyReply,
  ) {
    return this.clsiService.downloadAllArtifactsZip(spaceId, res);
  }

  @Get('status')
  @ApiOperation({
    summary: 'Check health status and probe compiler binaries',
  })
  public async getStatus() {
    return this.clsiService.getHealthReport();
  }

  @Get('metrics')
  @ApiOperation({
    summary: 'Prometheus metrics endpoint for compilation performance',
  })
  public async getMetrics(@Res() res: FastifyReply) {
    const metricsText = this.clsiService.getPrometheusMetrics();
    res.header('Content-Type', 'text/plain; version=0.0.4');
    return res.send(metricsText);
  }

  @Get('metrics/summary')
  @ApiOperation({
    summary: 'JSON metrics summary of compilation statistics',
  })
  public async getMetricsSummary() {
    return this.clsiService.getMetricsSummary();
  }

  @Post('admin/clean-scratch')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Trigger LRU garbage collection and disk quota enforcement',
  })
  public async cleanScratch() {
    return this.clsiService.cleanScratch();
  }
}

@Module({
  controllers: [ClsiController],
  providers: [ClsiService],
  exports: [ClsiService],
})
export class ClsiModule {}
