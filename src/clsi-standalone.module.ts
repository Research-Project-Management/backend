/**
 * clsi-standalone.module.ts
 * Standalone NestJS module & controller for the dedicated CLSI LaTeX compilation microservice.
 * Operates in an isolated TeX Live container without database or Redis dependencies,
 * reusing the canonical domain and pipeline engines from modules/manuscripts/clsi.
 */

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Injectable,
  Logger,
  Module,
  NotFoundException,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { FastifyReply } from 'fastify';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  CompileManuscriptDto,
  ClsiWordCountDto,
  ClsiCompilerEngine,
} from './modules/manuscripts/clsi/dto/clsi.dto';
import {
  ForwardSyncDto,
  ReverseSyncDto,
} from './modules/manuscripts/clsi/dto/synctex.dto';
import {
  OverleafIncrementalWorkspace,
  DiskUsageCleaner,
  createZipStreamFromDisk,
  ZipDiskEntry,
} from './modules/manuscripts/clsi/repositories/incremental-workspace.repository';
import {
  CompilePipeline,
  LocalProcessRunner,
  LatexmkEngine,
  ClsiHealthCheck,
} from './modules/manuscripts/clsi/services/compile-pipeline.service';
import { CompileLogAnalyzer } from './modules/manuscripts/diagnostics/domain';
import { SyncTexProcessor } from './modules/manuscripts/clsi/domain/synctex.parser';
import { TexWordCounter } from './modules/manuscripts/clsi/domain/tex-word.counter';
import { ClsiMetrics } from './modules/manuscripts/clsi/domain/clsi.metrics';

@Injectable()
export class ClsiStandaloneService {
  private readonly logger = new Logger(ClsiStandaloneService.name);
  private readonly workspace: OverleafIncrementalWorkspace;
  private readonly pipeline: CompilePipeline;
  private readonly synctexParser: SyncTexProcessor;
  private readonly wordCounter: TexWordCounter;
  private readonly diskUsageCleaner: DiskUsageCleaner;
  private readonly healthCheck: ClsiHealthCheck;
  private readonly metrics: ClsiMetrics = ClsiMetrics.getInstance();

  constructor() {
    const scratchDir =
      process.env.CLSI_SCRATCH_DIR ||
      process.env.SCRATCH_DIR ||
      '/tmp/clsi-scratch';
    const latexmkBin = process.env.LATEXMK_BIN || 'latexmk';

    this.workspace = new OverleafIncrementalWorkspace(scratchDir);
    const runner = new LocalProcessRunner();
    const latexmkEngine = new LatexmkEngine(runner, latexmkBin, 'pdflatex');
    const logParser = new CompileLogAnalyzer();

    this.synctexParser = new SyncTexProcessor();
    this.wordCounter = new TexWordCounter();
    this.diskUsageCleaner = new DiskUsageCleaner(scratchDir);
    this.healthCheck = new ClsiHealthCheck(runner, scratchDir);
    this.pipeline = new CompilePipeline(
      this.workspace,
      latexmkEngine,
      logParser,
    );
  }

  private normalizeCompileDto(dto: CompileManuscriptDto): void {
    if (dto.compile) {
      if (dto.compile.rootResourcePath && !dto.main_file && !dto.mainFile) {
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
      if (dto.compile.options?.timeout && !dto.timeout_ms && !dto.timeoutMs) {
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

  public async compile(dto: CompileManuscriptDto, routeProjectId?: string) {
    this.normalizeCompileDto(dto);
    const projectId =
      routeProjectId || dto.projectId || dto.project_id || 'default';
    const mainFile = dto.mainFile || dto.main_file || 'main.tex';
    const source = dto.source || '';
    const files = dto.files || {};
    const engine = dto.engine || 'pdflatex';
    const effectiveTimeoutMs = dto.timeout_ms ?? dto.timeoutMs ?? 240000;

    if (dto.force_clean || dto.forceClean) {
      await this.pipeline.runWithProjectLock(projectId, () =>
        this.workspace.cleanScratch(projectId),
      );
    }

    this.logger.log(`Compiling project ${projectId} using engine ${engine}`);

    const pipelineResult = await this.pipeline.execute({
      projectId,
      mainFile,
      engine,
      texLiveVersion: dto.tex_live_version || dto.texLiveVersion,
      draft: dto.draft,
      syntaxOnly: dto.syntax_only ?? dto.syntaxOnly,
      force: dto.force_clean ?? dto.forceClean,
      stopOnFirstError:
        dto.stopOnFirstError ?? dto.stop_on_first_error ?? false,
      timeoutMs: effectiveTimeoutMs,
      source,
      files,
    });

    this.metrics.record({
      engine,
      durationMs: pipelineResult.durationMs,
      success: pipelineResult.success,
      isCached: false,
      isTimeout: Boolean(pipelineResult.timedOut),
      pdfSizeBytes: pipelineResult.pdf
        ? Buffer.byteLength(pipelineResult.pdf, 'base64')
        : 0,
    });

    const { compile: _overleafEnvelope, ...flatResponse } = pipelineResult;
    return flatResponse;
  }

  private async loadSynctexContent(
    projectId: string,
    inlineSynctexBase64?: string,
  ): Promise<string | null> {
    if (inlineSynctexBase64) {
      const buffer = Buffer.from(inlineSynctexBase64, 'base64');
      return await this.synctexParser.decompress(buffer);
    }

    for (const filename of ['output.synctex.gz', 'output.synctex']) {
      try {
        const buf = await this.workspace.readAuxFile(projectId, filename);
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
    const projectId =
      dto.projectId || dto.project_id || dto.pageId || dto.page_id || 'default';
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

  public async reverseSync(dto: ReverseSyncDto) {
    const projectId =
      dto.projectId || dto.project_id || dto.pageId || dto.page_id || 'default';
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

  public getWordCount(dto: ClsiWordCountDto) {
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
    return {
      success: true,
      stats: this.wordCounter.count(dto.source),
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
    res.header(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(filename)}"`,
    );
    res.header('Content-Type', 'application/octet-stream');
    return res.send(buffer);
  }

  public async downloadAllArtifactsZip(projectId: string, res: FastifyReply) {
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
        // Ignore missing directories
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

  public async getHealthReport() {
    return this.healthCheck.checkHealth();
  }

  public getMetricsSummary() {
    return this.metrics.getSummary();
  }

  public getPrometheusMetrics(): string {
    return this.metrics.toPrometheus();
  }

  public async cleanScratch() {
    const staleStats = await this.diskUsageCleaner.cleanStaleProjects();
    const quotaStats = await this.diskUsageCleaner.enforceDiskQuota();
    return { staleStats, quotaStats };
  }
}

@ApiTags('CLSI Compilation Engine')
@Controller()
export class ClsiStandaloneController {
  constructor(private readonly clsiService: ClsiStandaloneService) {}

  @Post([
    'compile',
    'api/clsi/compile',
    'api/manuscripts/compile',
    'project/:projectId/compile',
  ])
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Compile LaTeX manuscript source to PDF (Overleaf parity)',
  })
  @ApiResponse({
    status: 200,
    description: 'Compilation finished (success or compiler error with logs)',
  })
  async compile(
    @Body() dto: CompileManuscriptDto,
    @Param('projectId') projectId?: string,
  ) {
    return this.clsiService.compile(dto, projectId);
  }

  @Post(['word-count', 'api/clsi/word-count', 'api/manuscripts/word-count'])
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Calculate academic word count and section metrics',
  })
  async wordCount(@Body() dto: ClsiWordCountDto) {
    return this.clsiService.getWordCount(dto);
  }

  @Post(['synctex/forward', 'api/clsi/synctex/forward'])
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Forward SyncTeX: map LaTeX source line/column to PDF coordinates',
  })
  async forwardSync(@Body() dto: ForwardSyncDto) {
    return this.clsiService.forwardSync(dto);
  }

  @Post(['synctex/reverse', 'api/clsi/synctex/reverse'])
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Reverse SyncTeX: map clicked PDF coordinates to LaTeX line/column',
  })
  async reverseSync(@Body() dto: ReverseSyncDto) {
    return this.clsiService.reverseSync(dto);
  }

  @Get(['artifacts/:projectId', 'api/clsi/artifacts/:projectId'])
  @ApiOperation({
    summary: 'List auxiliary build files generated by compilation',
  })
  async listAuxFiles(@Param('projectId') projectId: string) {
    return this.clsiService.listAuxFiles(projectId);
  }

  @Get([
    'artifacts/:projectId/:filename',
    'api/clsi/artifacts/:projectId/:filename',
  ])
  @ApiOperation({ summary: 'Download a specific auxiliary file' })
  async downloadAuxFile(
    @Param('projectId') projectId: string,
    @Param('filename') filename: string,
    @Res() res: FastifyReply,
  ) {
    return this.clsiService.downloadAuxFile(projectId, filename, res);
  }

  @Get(['artifacts-zip/:projectId', 'api/clsi/artifacts-zip/:projectId'])
  @ApiOperation({
    summary:
      'Download all project output artifacts packaged as a ZIP archive',
  })
  async downloadAllArtifactsZip(
    @Param('projectId') projectId: string,
    @Res() res: FastifyReply,
  ) {
    return this.clsiService.downloadAllArtifactsZip(projectId, res);
  }

  @Get(['status', 'isalive', 'api/clsi/status', 'health/liveness'])
  @ApiOperation({
    summary: 'Check health status and probe compiler binaries',
  })
  async getStatus() {
    return this.clsiService.getHealthReport();
  }

  @Get(['metrics', 'api/clsi/metrics'])
  @ApiOperation({
    summary: 'Prometheus metrics endpoint for compilation performance',
  })
  async getMetrics(@Res() res: FastifyReply) {
    const metricsText = this.clsiService.getPrometheusMetrics();
    res.header('Content-Type', 'text/plain; version=0.0.4');
    return res.send(metricsText);
  }

  @Get(['metrics/summary', 'api/clsi/metrics/summary'])
  @ApiOperation({
    summary: 'JSON metrics summary of compilation statistics',
  })
  async getMetricsSummary() {
    return this.clsiService.getMetricsSummary();
  }

  @Post(['admin/clean-scratch', 'api/clsi/admin/clean-scratch'])
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Trigger LRU garbage collection and disk quota enforcement',
  })
  async cleanScratch() {
    return this.clsiService.cleanScratch();
  }
}

@Module({
  controllers: [ClsiStandaloneController],
  providers: [ClsiStandaloneService],
})
export class ClsiStandaloneModule {}
