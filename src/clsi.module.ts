/**
 * clsi.module.ts
 * Dedicated NestJS module & controller for the CLSI LaTeX compilation microservice.
 * Operates in an isolated TeX Live container without database or Redis dependencies,
 * reusing the canonical domain and pipeline engines from modules/pages/clsi.
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
} from './modules/pages/clsi/dto/clsi.dto';
import {
  ForwardSyncDto,
  ReverseSyncDto,
} from './modules/pages/clsi/dto/synctex.dto';
import {
  WorkspaceRepository,
  DiskUsageCleaner,
  createZipStreamFromDisk,
  ZipDiskEntry,
} from './modules/pages/clsi/repositories/workspace.repository';
import {
  CompilePipeline,
  LocalProcessRunner,
  LatexmkEngine,
  ClsiHealthCheck,
} from './modules/pages/clsi/services/compile-pipeline.service';
import { CompileLogAnalyzer } from './modules/pages/diagnostics/domain';
import { SyncTexProcessor } from './modules/pages/clsi/domain/synctex.parser';
import { TexWordCounter } from './modules/pages/clsi/domain/tex-word.counter';
import { ClsiMetrics } from './modules/pages/clsi/domain/clsi.metrics';

@Injectable()
export class ClsiService {
  private readonly logger = new Logger(ClsiService.name);
  private readonly workspace: WorkspaceRepository;
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

    this.workspace = new WorkspaceRepository(scratchDir);
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

  public async compile(dto: CompileManuscriptDto) {
    const projectId = dto.projectId || 'default';
    const mainFile = dto.mainFile || 'main.tex';
    const source = dto.source || '';
    const files = dto.files || {};
    const engine = dto.engine || 'pdflatex';
    const effectiveTimeoutMs = dto.timeoutMs ?? 240000;

    if (dto.forceClean) {
      await this.pipeline.runWithProjectLock(projectId, () =>
        this.workspace.cleanScratch(projectId),
      );
    }

    this.logger.log(`Compiling project ${projectId} using engine ${engine}`);

    const pipelineResult = await this.pipeline.execute({
      projectId,
      mainFile,
      engine,
      texLiveVersion: dto.texLiveVersion || '2025',
      draft: dto.draft,
      syntaxOnly: dto.syntaxOnly,
      force: dto.forceClean,
      stopOnFirstError: dto.stopOnFirstError ?? false,
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

    return pipelineResult;
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
    const projectId = dto.projectId || dto.pageId || 'default';
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
    const projectId = dto.projectId || dto.pageId || 'default';
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

  public async downloadAllArtifactsZip(
    projectId: string,
    res: FastifyReply,
  ) {
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
        // scratch may not exist yet or was cleaned
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

  public getPrometheusMetrics() {
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
export class ClsiController {
  constructor(private readonly clsiService: ClsiService) {}

  @Post('compile')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Compile LaTeX manuscript source to PDF',
  })
  @ApiResponse({
    status: 200,
    description: 'Compilation finished (success or compiler error with logs)',
  })
  public async compile(@Body() dto: CompileManuscriptDto) {
    return this.clsiService.compile(dto);
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
    summary: 'Reverse SyncTeX: map clicked PDF coordinates to LaTeX line/column',
  })
  public async reverseSync(@Body() dto: ReverseSyncDto) {
    return this.clsiService.reverseSync(dto);
  }

  @Get('artifacts/:projectId')
  @ApiOperation({
    summary: 'List auxiliary build files generated by compilation',
  })
  public async listAuxFiles(@Param('projectId') projectId: string) {
    return this.clsiService.listAuxFiles(projectId);
  }

  @Get('artifacts/:projectId/:filename')
  @ApiOperation({ summary: 'Download a specific auxiliary file' })
  public async downloadAuxFile(
    @Param('projectId') projectId: string,
    @Param('filename') filename: string,
    @Res() res: FastifyReply,
  ) {
    return this.clsiService.downloadAuxFile(projectId, filename, res);
  }

  @Get('artifacts-zip/:projectId')
  @ApiOperation({
    summary: 'Download all project output artifacts packaged as a ZIP archive',
  })
  public async downloadAllArtifactsZip(
    @Param('projectId') projectId: string,
    @Res() res: FastifyReply,
  ) {
    return this.clsiService.downloadAllArtifactsZip(projectId, res);
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
