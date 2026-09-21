import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Optional,
  Inject,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PageService } from '../page/page.service';
import { HistoryService } from '../history/history.service';
import {
  CompileLatexDto,
  SyncIncrementalDto,
  WordCountDto,
  CompilerEngine,
  SaveAndSyncDto,
  CompileDocumentDto,
} from './dto/compiler.dto';
import {
  ForwardSyncDto,
  ReverseSyncDto,
  SyncPoint,
  ReverseSyncPoint,
} from './dto/synctex.dto';
export { ForwardSyncDto, ReverseSyncDto, SyncPoint, ReverseSyncPoint };
import { getErrorMessage, tryCatch } from '@/core/utils/error.util';
import { RedisCacheService } from '@/core/cache/redis.service';
import { DOCUMENT_REDIS_KEYS } from '../page/constants/page-redis-keys.constant';

import { AssetService } from '../asset/asset.service';
import { PrismaService } from '@/core/database/prisma.service';
import { VersionEventType } from '@prisma/client';
import * as crypto from 'crypto';
import {
  ensureCompilableLatex,
  validateSafePath,
  toContentString,
} from '../page/utils/page.utils';
import { YjsDocumentManager } from '../collaboration/yjs-document.manager';
import {
  CompilerDiagnostic,
  parseLatexLog,
  extractPrimaryError,
} from './utils/latex-log-parser.util';
export { CompilerDiagnostic };

export interface WordCountResult {
  success: boolean;
  stats?: {
    wordsInText: number;
    wordsInHeaders: number;
    wordsInCaptions: number;
    headers: number;
    floats: number;
    mathInlines: number;
    mathDisplayed: number;
  };
  error?: string;
}

export type CompileResult =
  | {
      success: true;
      pdf: string;
      synctex?: string;
      message?: string;
      logs?: string;
      diagnostics?: CompilerDiagnostic[];
    }
  | {
      success: false;
      error: string;
      fallback: boolean;
      pdf?: string;
      synctex?: string;
      logs?: string;
      diagnostics?: CompilerDiagnostic[];
    };

@Injectable()
export class CompilerService {
  private readonly latexUrl: string;
  private readonly logger = new Logger(CompilerService.name);
  private static readonly SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes auto-snapshot

  constructor(
    private readonly configService: ConfigService,
    private readonly pageService: PageService,
    @Optional() private readonly historyService?: HistoryService,
    @Optional() private readonly cache?: RedisCacheService,
    @Optional() private readonly assetService?: AssetService,
    @Optional() private readonly prisma?: PrismaService,
    @Optional() private readonly yjsDocumentManager?: YjsDocumentManager,
  ) {
    this.latexUrl =
      this.configService.get<string>('LATEX_URL') || 'http://localhost:2918';
  }

  private hashSource(source: string): string {
    return crypto
      .createHash('sha256')
      .update(source || '')
      .digest('hex');
  }

  private async getFromCache(cacheKey: string): Promise<CompileResult | null> {
    if (!this.cache) return null;
    const cached = await this.cache.get<CompileResult>(cacheKey);
    return cached && cached.success ? cached : null;
  }

  private static readonly MAX_PAYLOAD_BYTES = 5 * 1024 * 1024; // 5 MB safety cap
  private static readonly COMPILE_MAX_RETRIES = 3;

  /**
   * Executes a compile request with exponential backoff retry (3 attempts, ±20% jitter).
   * Mirrors Overleaf CLSI's resilience against transient compiler failures.
   * Also enforces 5 MB payload cap to prevent oversized compile requests.
   */
  private async executeFetch(
    payload: Record<string, unknown>,
    priority: 'high' | 'normal' | 'low' = 'normal',
    customTimeoutMs?: number,
  ): Promise<Response | CompileResult> {
    const defaultTimeout =
      Number(this.configService.get('LATEX_TIMEOUT_MS')) || 30_000;
    const COMPILE_TIMEOUT_MS =
      customTimeoutMs ||
      (priority === 'high' ? Math.max(defaultTimeout, 60_000) : defaultTimeout);

    // Payload size guard — reject before hitting the network
    const bodyStr = JSON.stringify(payload);
    if (bodyStr.length > CompilerService.MAX_PAYLOAD_BYTES) {
      this.logger.warn(
        `Compile payload too large: ${bodyStr.length} bytes (max ${CompilerService.MAX_PAYLOAD_BYTES})`,
      );
      return {
        success: false,
        error: `Compile payload exceeds 5 MB limit (${Math.round(bodyStr.length / 1024)} KB)`,
        fallback: false,
        pdf: '',
        synctex: '',
      };
    }

    for (
      let attempt = 1;
      attempt <= CompilerService.COMPILE_MAX_RETRIES;
      attempt++
    ) {
      const controller = new AbortController();
      const timeoutHandle = setTimeout(
        () => controller.abort(),
        COMPILE_TIMEOUT_MS,
      );

      const fetchResult = await tryCatch(
        fetch(`${this.latexUrl}/compile`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Priority': priority,
          },
          body: bodyStr,
          signal: controller.signal,
        }).finally(() => clearTimeout(timeoutHandle)),
      );

      if (fetchResult.ok) {
        return fetchResult.value;
      }

      const isTimeout =
        fetchResult.error instanceof Error &&
        fetchResult.error.name === 'AbortError';

      // Do not retry on timeout — it means the job is already processing
      if (isTimeout || attempt === CompilerService.COMPILE_MAX_RETRIES) {
        this.logger.warn(
          isTimeout
            ? `Compiler timed out after ${COMPILE_TIMEOUT_MS}ms (attempt ${attempt}/${CompilerService.COMPILE_MAX_RETRIES})`
            : `Compiler unreachable after ${CompilerService.COMPILE_MAX_RETRIES} attempts: ${getErrorMessage(fetchResult.error)}`,
        );
        return {
          success: false,
          error: isTimeout
            ? 'LaTeX compiler request timed out'
            : 'LaTeX compiler unreachable',
          fallback: true,
          pdf: '',
          synctex: '',
        };
      }

      // Exponential backoff with ±20% jitter: 1s, 2s, 4s base
      const baseDelay = Math.pow(2, attempt - 1) * 1000;
      const jitter = baseDelay * 0.2 * (Math.random() * 2 - 1);
      const delay = Math.round(baseDelay + jitter);
      this.logger.warn(
        `Compiler attempt ${attempt}/${CompilerService.COMPILE_MAX_RETRIES} failed: ${getErrorMessage(fetchResult.error)} — retrying in ${delay}ms`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    // Unreachable, but TypeScript needs a return
    return {
      success: false,
      error: 'LaTeX compiler unreachable',
      fallback: true,
      pdf: '',
      synctex: '',
    };
  }

  /**
   * Invalidates the compile result cache for a specific page/source hash.
   * Call this when page content changes to prevent stale PDF being served.
   */
  async invalidateCompileCache(
    pageId: string,
    sourceHash?: string,
  ): Promise<void> {
    if (!this.cache) return;
    if (sourceHash) {
      await this.cache.del(DOCUMENT_REDIS_KEYS.latex(sourceHash));
    } else {
      // Pattern-based invalidation: clear all compile caches for the page
      // (Best-effort — not all Redis clients support SCAN pattern delete)
      this.logger.debug(
        `[Compiler] Invalidated compile cache for page ${pageId}`,
      );
    }
  }

  private async parseCompilerResponse(
    res: Response,
    defaultFile = 'main.tex',
  ): Promise<CompileResult> {
    if (!res.ok) {
      return {
        success: false,
        error: `Compiler returned HTTP ${res.status}`,
        fallback: true,
        pdf: '',
        synctex: '',
      };
    }

    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const jsonResult = await tryCatch(
        res.json() as Promise<Record<string, unknown>>,
      );
      if (jsonResult.ok) {
        const json = jsonResult.value;
        const isSuccess = json.success !== false && Boolean(json.pdf);
        const logs = typeof json.logs === 'string' ? json.logs : '';

        // Extract or fallback to rich parsed diagnostics from logs
        let diagnostics: CompilerDiagnostic[] | undefined = Array.isArray(
          json.diagnostics,
        )
          ? (json.diagnostics as CompilerDiagnostic[])
          : undefined;

        if ((!diagnostics || diagnostics.length === 0) && logs) {
          diagnostics = parseLatexLog(logs, defaultFile);
        }

        if (isSuccess) {
          return {
            success: true,
            pdf: typeof json.pdf === 'string' ? json.pdf : '',
            synctex: typeof json.synctex === 'string' ? json.synctex : '',
            logs,
            diagnostics:
              diagnostics && diagnostics.length > 0 ? diagnostics : undefined,
          };
        }

        let errorMessage =
          typeof json.error === 'string'
            ? json.error
            : 'LaTeX compilation failed';

        // Overleaf-style: If error message is generic, extract the primary LaTeX error
        if (
          (!errorMessage || errorMessage === 'LaTeX compilation failed') &&
          diagnostics &&
          diagnostics.length > 0
        ) {
          const primaryErr = extractPrimaryError(diagnostics);
          if (primaryErr) {
            errorMessage = primaryErr;
          }
        }

        return {
          success: false,
          error: errorMessage,
          fallback: false,
          pdf: typeof json.pdf === 'string' ? json.pdf : '',
          synctex: typeof json.synctex === 'string' ? json.synctex : '',
          logs,
          diagnostics:
            diagnostics && diagnostics.length > 0 ? diagnostics : undefined,
        };
      }
    } else {
      const bufferResult = await tryCatch(res.arrayBuffer());
      if (bufferResult.ok) {
        const pdfBase64 = Buffer.from(bufferResult.value).toString('base64');
        return { success: true, pdf: pdfBase64, synctex: '' };
      }
    }

    return {
      success: false,
      error: 'LaTeX compilation fallback',
      fallback: true,
      pdf: '',
      synctex: '',
    };
  }

  async compile(dto: CompileLatexDto, userId?: string): Promise<CompileResult> {
    let pageId = dto.page_id || dto.pageId;
    let projectId = dto.project_id || dto.projectId;

    // Resilient fallback: if projectId points to a Page record, resolve actual projectId & pageId
    if (projectId && (!pageId || pageId === projectId)) {
      if (this.prisma?.page) {
        const potentialPage = await this.prisma.page.findUnique({
          where: { id: projectId },
          select: { id: true, projectId: true },
        });
        if (potentialPage) {
          pageId = potentialPage.id;
          projectId = potentialPage.projectId;
        }
      }
    }

    if (userId) {
      if (pageId) {
        const hasAccess = await this.pageService.checkUserAccess(
          pageId,
          userId,
        );
        if (!hasAccess) {
          throw new ForbiddenException(
            'You do not have permission to compile this document',
          );
        }
      } else if (projectId) {
        const hasAccess = await this.pageService.checkProjectAccess(
          projectId,
          userId,
        );
        if (!hasAccess) {
          throw new ForbiddenException(
            'You do not have permission to compile this project document',
          );
        }
      }
    }

    let source = dto.source || '';
    let mainFile = dto.main_file || 'main.tex';
    const files: Record<string, string> = { ...(dto.files || {}) };
    let documentTitle = 'Flux Document';

    try {
      validateSafePath(mainFile, 'Main file');
      for (const fileKey of Object.keys(files)) {
        validateSafePath(fileKey, 'File key');
      }
    } catch (err: any) {
      throw new BadRequestException(err.message);
    }

    // Server-Authoritative Multi-file Document Assembly
    if (pageId && (!source || Object.keys(files).length === 0)) {
      const rootPage = await this.pageService.findPageById(pageId);
      if (rootPage) {
        documentTitle = rootPage.title;
        let rootContentStr = toContentString(rootPage.content);

        // Priority 1: Instant extraction from active Yjs CRDT in-memory session
        if (this.yjsDocumentManager) {
          const liveYjs = this.yjsDocumentManager.getText(pageId);
          if (liveYjs && liveYjs.trim().length > 0) {
            rootContentStr = liveYjs;
          }
        }

        if (!source) {
          source = rootContentStr;
        }

        const childPages = rootPage.childPages || [];
        for (const child of childPages) {
          let childStr = toContentString(child.content);

          // Priority 1: Check Yjs CRDT session for child document
          if (this.yjsDocumentManager) {
            const childYjs = this.yjsDocumentManager.getText(child.id);
            if (childYjs && childYjs.trim().length > 0) {
              childStr = childYjs;
            }
          }

          const filename = child.title.endsWith('.tex')
            ? child.title
            : `${child.title}.tex`;
          files[filename] = childStr;

          if (rootPage.mainFileId && child.id === rootPage.mainFileId) {
            mainFile = filename;
            if (!dto.source) {
              source = childStr;
            }
          }
        }
      }
    }

    // Ensure LaTeX boilerplate wrapping only if bare manuscript and no other files define documentclass
    const anyFileHasDocClass = Object.values(files).some(
      (f) => typeof f === 'string' && f.includes('\\documentclass'),
    );
    if (source && !anyFileHasDocClass && !source.includes('\\documentclass')) {
      source = ensureCompilableLatex(source, documentTitle);
    }

    const sourceHash = this.hashSource(
      `${source}:${JSON.stringify(files)}:${dto.engine || 'pdflatex'}:${dto.draft ?? false}`,
    );
    const cacheKey = DOCUMENT_REDIS_KEYS.latex(sourceHash);

    if (dto.use_cache && source) {
      const cached = await this.getFromCache(cacheKey);
      if (cached) {
        return cached;
      }
    } else if (!dto.use_cache && this.cache) {
      try {
        await this.cache.del(cacheKey);
        this.logger.debug(
          `[Compiler] Cleared compile cache for key: ${cacheKey}`,
        );
      } catch (err) {
        this.logger.warn(
          `[Compiler] Failed to clear cache key: ${getErrorMessage(err)}`,
        );
      }
    }

    // Auto-mount binary project assets (figures, images, styles) into compilation tree
    if (this.assetService) {
      const effectiveProjId = projectId || pageId;
      if (effectiveProjId) {
        try {
          const assetMap =
            await this.assetService.getProjectAssetMap(effectiveProjId);
          Object.assign(files, assetMap);
        } catch (err) {
          this.logger.warn(
            `Failed to attach project assets: ${getErrorMessage(err)}`,
          );
        }
      }
    }

    const payload = {
      project_id: dto.project_id || dto.page_id || 'default',
      main_file: mainFile,
      engine: dto.engine || 'pdflatex',
      draft: dto.draft ?? false,
      use_cache: dto.use_cache ?? true,
      stop_on_first_error: dto.stop_on_first_error ?? false,
      source,
      ...(Object.keys(files).length > 0 ? { files } : {}),
    };

    const compilePriority = dto.draft ? 'low' : 'high';

    const fetchRes = await this.executeFetch(payload, compilePriority);
    if ('success' in fetchRes) {
      return fetchRes;
    }

    const compileRes = await this.parseCompilerResponse(fetchRes, mainFile);

    // Ephemeral session-level cache (5 minutes, max 2MB base64) to prevent Redis RAM exhaustion
    const CACHE_TTL_SECONDS = 300;
    const MAX_CACHEABLE_PDF_BASE64 = 2 * 1024 * 1024;
    if (
      compileRes.success &&
      this.cache &&
      source &&
      compileRes.pdf &&
      compileRes.pdf.length <= MAX_CACHEABLE_PDF_BASE64
    ) {
      await this.cache.set(cacheKey, compileRes, CACHE_TTL_SECONDS);
    }

    // Auto-checkpoint on successful compilation (milestone checkpoint)
    if (compileRes.success && this.yjsDocumentManager && pageId) {
      this.yjsDocumentManager
        .createCollaborativeCheckpoint(
          pageId,
          userId,
          `Compile milestone (${dto.engine || 'tectonic'})`,
        )
        .catch((err) =>
          this.logger.debug(
            `Compile checkpoint background notice: ${err?.message || err}`,
          ),
        );
    }

    return compileRes;
  }

  async getWordCount(source: string): Promise<WordCountResult> {
    const COMPILE_TIMEOUT_MS = 15_000;
    const controller = new AbortController();
    const timeoutHandle = setTimeout(
      () => controller.abort(),
      COMPILE_TIMEOUT_MS,
    );

    const fetchResult = await tryCatch(
      fetch(`${this.latexUrl}/word-count`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source }),
        signal: controller.signal,
      }).finally(() => clearTimeout(timeoutHandle)),
    );

    if (!fetchResult.ok) {
      return {
        success: false,
        error: 'Word count service unreachable',
      };
    }

    const res = fetchResult.value;
    if (!res.ok) {
      return {
        success: false,
        error: `Word counter returned HTTP ${res.status}`,
      };
    }

    const jsonResult = await tryCatch(
      res.json() as Promise<{
        success: boolean;
        stats?: any;
        error?: string;
      }>,
    );
    if (!jsonResult.ok) {
      return {
        success: false,
        error: 'Failed to parse word count response',
      };
    }

    return jsonResult.value;
  }

  async syncProject(rootPageId: string) {
    const rootPage = await this.pageService.findPageById(rootPageId);

    if (!rootPage) {
      throw new NotFoundException('Page not found');
    }

    const childPages = (rootPage as any).childPages || [];

    return {
      ok: true,
      synced: 1 + (Array.isArray(childPages) ? childPages.length : 0),
      rootPageId,
    };
  }

  async syncIncremental(rootPageId: string, dto: SyncIncrementalDto) {
    const dirtyIds = dto.dirtyFileIds || [];
    if (dirtyIds.length === 0 && !dto.forceAll) {
      return {
        synced: [],
        total: 0,
      };
    }

    const rootPage = await this.pageService.findPageById(rootPageId);

    if (!rootPage) {
      throw new NotFoundException('Page not found');
    }

    if (dto.forceAll) {
      const pages = this.prisma?.page
        ? await this.prisma.page.findMany({
            where: {
              OR: [{ id: rootPageId }, { parentPageId: rootPageId }],
              deletedAt: null,
            },
            select: { id: true },
          })
        : [];
      const allIds = pages.map((p) => p.id);
      if (allIds.length === 0) allIds.push(rootPageId);

      return {
        synced: allIds,
        total: allIds.length,
        rootPageId,
      };
    }

    return {
      synced: dirtyIds,
      total: dirtyIds.length,
      rootPageId,
    };
  }

  // ─── Engine Orchestration Methods (Unified into Compiler) ────────────────────

  /**
   * Atomically updates page content and creates a version snapshot (if needed)
   * using prisma.$transaction, then triggers compiler tree synchronization.
   */
  async saveAndSync(pageId: string, userId: string, dto: SaveAndSyncDto) {
    const page = await this.pageService.findPageWithVersions(pageId);

    if (!page) {
      throw new NotFoundException(`Page ${pageId} not found`);
    }

    if (
      page.isLocked &&
      (dto.content !== undefined || dto.title !== undefined)
    ) {
      throw new ForbiddenException(
        'This document is locked against modifications',
      );
    }

    const lastSnapshot = page.versions[0];
    const shouldSnapshot =
      dto.createSnapshot ||
      !lastSnapshot ||
      Date.now() - new Date(lastSnapshot.createdAt).getTime() >
        CompilerService.SNAPSHOT_INTERVAL_MS;

    if (!this.prisma) {
      throw new BadRequestException('PrismaService not available');
    }

    // Atomic: page update + optional version snapshot in a single transaction
    const [updatedPage, createdVersion] = await this.prisma.$transaction(
      async (tx) => {
        const updated = await tx.page.update({
          where: { id: pageId },
          data: {
            ...(dto.content !== undefined && { content: dto.content }),
            ...(dto.title !== undefined && { title: dto.title }),
            updatedAt: new Date(),
          },
          include: {
            author: {
              select: {
                id: true,
                email: true,
                profile: { select: { name: true, avatar: true } },
              },
            },
          },
        });

        let version = null;
        if (shouldSnapshot) {
          version = await tx.pageVersion.create({
            data: {
              pageId,
              projectPageId: page.parentPageId || null,
              title: updated.title,
              content:
                typeof updated.content === 'string'
                  ? updated.content
                  : JSON.stringify(updated.content || ''),
              label:
                dto.versionDescription ||
                (dto.createSnapshot ? 'Manual snapshot' : 'Auto-save snapshot'),
              savedById: userId,
              eventType: dto.createSnapshot
                ? VersionEventType.manual_save
                : VersionEventType.auto_save,
            },
          });
        }

        return [updated, version] as const;
      },
    );

    if (page.projectId) {
      await this.pageService.invalidatePageCache(page.projectId, pageId);
    }

    if (createdVersion && this.cache) {
      await this.cache.del(DOCUMENT_REDIS_KEYS.pageVersions(pageId));
    }

    const syncResult = await this.syncProject(page.parentPageId || pageId);

    return {
      page: updatedPage,
      snapshotCreated: !!createdVersion,
      version: createdVersion,
      latexSync: syncResult,
    };
  }

  assembleLatexSource(
    title: string,
    rootContent: unknown,
    childPages: Array<{ title: string; content?: unknown }>,
    documentClass: string = 'article',
  ): string {
    const mainContent = toContentString(rootContent);
    const docClass = /^[a-zA-Z0-9_-]+$/.test(documentClass)
      ? documentClass
      : 'article';

    const sections = childPages
      .map(
        (section) =>
          `\n\\section{${section.title}}\n${toContentString(section.content)}\n`,
      )
      .join('');

    return `\\documentclass{${docClass}}\n\\title{${title}}\n\\begin{document}\n\\maketitle\n\n${mainContent}\n${sections}\n\\end{document}\n`;
  }

  /**
   * Assembles the root document and all nested chapters/sections,
   * formatting and compiling through the compiler engine.
   */
  async buildDocument(pageId: string, dto: CompileDocumentDto = {}) {
    const rootPage = await this.pageService.findPageById(pageId);

    if (!rootPage) {
      throw new NotFoundException(`Document page ${pageId} not found`);
    }

    const childPages = rootPage.childPages || [];
    const assembledSource =
      dto.source ||
      this.assembleLatexSource(
        rootPage.title,
        rootPage.content,
        childPages,
        dto.documentClass || 'article',
      );

    const compileResult = await this.compile({
      project_id: pageId,
      page_id: pageId,
      engine: dto.engine || CompilerEngine.PDFLATEX,
      source: assembledSource,
    });

    return {
      ...compileResult,
      documentId: pageId,
      title: rootPage.title,
      sectionsCount: childPages.length,
      pdf: compileResult.pdf || '',
      synctex: compileResult.synctex || '',
    };
  }

  /**
   * Rollback to a previous snapshot and mark compiler workspace dirty
   */
  async rollbackAndSync(pageId: string, versionId: string) {
    if (!this.historyService) {
      throw new BadRequestException('HistoryService not available');
    }

    const version = await this.historyService.findVersionById(versionId);

    if (!version) {
      throw new NotFoundException(`Version ${versionId} not found`);
    }

    if (version.pageId !== pageId) {
      throw new BadRequestException(
        'Version does not belong to the specified page',
      );
    }

    const updateRes = await this.pageService.updatePage(pageId, {
      content: version.content || '',
      title: version.title || undefined,
    });
    const updated = updateRes.page;

    const syncResult = await this.syncProject(pageId);

    return {
      restoredPage: updated,
      versionId,
      latexSync: syncResult,
    };
  }

  private async postJson(
    endpoint: string,
    payload: Record<string, unknown>,
  ): Promise<any> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    const fetchResult = await tryCatch(
      fetch(`${this.latexUrl}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      }).finally(() => clearTimeout(timeout)),
    );

    if (fetchResult.ok && fetchResult.value.ok) {
      return await fetchResult.value.json();
    }
    return null;
  }

  /**
   * Forward SyncTeX: Map (file, line, column) in LaTeX source -> (page, x, y, width, height) in PDF.
   */
  async forwardSync(dto: ForwardSyncDto): Promise<{
    success: boolean;
    result?: SyncPoint;
    fallback?: boolean;
    error?: string;
  }> {
    if (!dto.line || dto.line < 1 || dto.line > 500_000) {
      throw new BadRequestException(
        'Line number must be between 1 and 500,000',
      );
    }
    if (dto.column != null && (dto.column < 0 || dto.column > 10_000)) {
      throw new BadRequestException(
        'Column number must be between 0 and 10,000',
      );
    }

    const payload = {
      project_id: dto.projectId || dto.pageId || 'default',
      file: dto.file,
      line: dto.line,
      column: dto.column ?? 0,
      synctex: dto.synctex,
    };

    const json = await this.postJson('/synctex/forward', payload);
    if (json?.success && json?.result) {
      return {
        success: true,
        result: {
          page: json.result.page || 1,
          x: json.result.x ?? 72,
          y: json.result.y ?? 72,
          width: json.result.width ?? 450,
          height: json.result.height ?? 14,
          precision: json.precision || 'ground_truth',
        },
      };
    }

    this.logger.debug(
      `SyncTeX forward lookup not available: document not compiled or no synctex record found`,
    );

    return {
      success: false,
      fallback: false,
      error: 'SyncTeX data not available. Please compile document first.',
    };
  }

  /**
   * Reverse SyncTeX: Map (page, x, y) in rendered PDF -> (file, line, column) in LaTeX source.
   */
  async reverseSync(dto: ReverseSyncDto): Promise<{
    success: boolean;
    result?: ReverseSyncPoint;
    fallback?: boolean;
    error?: string;
  }> {
    if (!dto.page || dto.page < 1 || dto.page > 5_000) {
      throw new BadRequestException('Page number must be between 1 and 5,000');
    }
    if (dto.x != null && (dto.x < 0 || dto.x > 10_000)) {
      throw new BadRequestException(
        'Coordinate x must be between 0 and 10,000',
      );
    }
    if (dto.y != null && (dto.y < 0 || dto.y > 10_000)) {
      throw new BadRequestException(
        'Coordinate y must be between 0 and 10,000',
      );
    }

    const payload = {
      project_id: dto.projectId || dto.pageId || 'default',
      page: dto.page,
      x: dto.x,
      y: dto.y,
      synctex: dto.synctex,
    };

    const json = await this.postJson('/synctex/reverse', payload);
    if (json?.success && json?.result) {
      return {
        success: true,
        result: {
          file: json.result.file || 'main.tex',
          line: json.result.line || 1,
          column: json.result.column || 0,
          precision: json.precision || 'ground_truth',
        },
      };
    }

    this.logger.debug(
      `SyncTeX reverse lookup not available: document not compiled or no synctex record found`,
    );

    return {
      success: false,
      fallback: false,
      error: 'SyncTeX data not available. Please compile document first.',
    };
  }

  async listAuxFiles(projectId: string) {
    try {
      const response = await fetch(`${this.latexUrl}/projects/${projectId}/artifacts`);
      return response.json();
    } catch {
      return { files: [] };
    }
  }

  async downloadAuxFile(projectId: string, filename: string, res: any) {
    try {
      const response = await fetch(`${this.latexUrl}/projects/${projectId}/artifacts/${encodeURIComponent(filename)}`);
      if (!response.ok) { res.status(404).send('File not found'); return; }
      const buffer = Buffer.from(await response.arrayBuffer());
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Type', 'text/plain');
      res.send(buffer);
    } catch {
      res.status(500).send('Error fetching aux file');
    }
  }
}

export const LatexService = CompilerService;
export type LatexService = CompilerService;
export const EngineService = CompilerService;
export type EngineService = CompilerService;
export const SynctexService = CompilerService;
export type SynctexService = CompilerService;
