import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CoreService } from '../core/core.service';
import { HistoryService } from '../history/history.service';
import {
  CompileLatexDto,
  SyncIncrementalDto,
  WordCountDto,
  CompilerEngine,
  SaveAndSyncDto,
  CompileDocumentDto,
} from './dto/compiler.dto';
import { getErrorMessage, tryCatch } from '@/core/utils/error.util';
import { RedisCacheService } from '@/core/cache/redis.service';
import { DOCUMENT_REDIS_KEYS } from '../core/constants/redis-keys.constant';
import { LibraryFacade } from '../../library/library.facade';
import { AssetService } from '../asset/asset.service';
import { PrismaService } from '@/core/database/prisma.service';
import { VersionEventType } from '@prisma/client';
import * as crypto from 'crypto';
import {
  ensureCompilableLatex,
  validateSafePath,
} from '../core/utils/document.utils';

export interface CompilerDiagnostic {
  file: string;
  line: number | null;
  message: string;
  context: string;
  severity: 'error' | 'warning' | 'info';
  code?: string;
  suggestion?: string;
}

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

const LATEX_CITE_REGEX =
  /\\(?:auto|paren|text|foot|no)?cite(?:p|t|alt|alp|author|year|date|num)?\*?(?:\[[^\]]*\])?(?:\[[^\]]*\])?\{([^}]+)\}/gi;

function extractCitationKeys(text: string): string[] {
  if (!text) return [];
  const foundKeys = new Set<string>();
  let match: RegExpExecArray | null;
  LATEX_CITE_REGEX.lastIndex = 0;
  while ((match = LATEX_CITE_REGEX.exec(text)) !== null) {
    const rawKeys = match[1];
    if (rawKeys) {
      for (const rawKey of rawKeys.split(',')) {
        const clean = rawKey.trim();
        if (clean && /^[a-zA-Z0-9_:-]+$/.test(clean)) {
          foundKeys.add(clean);
        }
      }
    }
  }
  return Array.from(foundKeys);
}

function toContentString(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object') {
    const obj = content as Record<string, unknown>;
    return (
      (obj.source as string) ||
      (obj.text as string) ||
      (obj.content as string) ||
      JSON.stringify(content)
    );
  }
  return '';
}

@Injectable()
export class CompilerService {
  private readonly latexUrl: string;
  private readonly logger = new Logger(CompilerService.name);
  private static readonly SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes auto-snapshot

  constructor(
    private readonly configService: ConfigService,
    private readonly pageService: CoreService,
    @Optional() private readonly historyService?: HistoryService,
    @Optional() private readonly cache?: RedisCacheService,
    @Optional() private readonly libraryFacade?: LibraryFacade,
    @Optional() private readonly assetService?: AssetService,
    @Optional() private readonly prisma?: PrismaService,
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

  private async executeFetch(
    payload: Record<string, unknown>,
  ): Promise<Response | CompileResult> {
    const COMPILE_TIMEOUT_MS = 30_000;
    const controller = new AbortController();
    const timeoutHandle = setTimeout(
      () => controller.abort(),
      COMPILE_TIMEOUT_MS,
    );

    const fetchResult = await tryCatch(
      fetch(`${this.latexUrl}/compile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      }).finally(() => clearTimeout(timeoutHandle)),
    );

    if (!fetchResult.ok) {
      const isTimeout =
        fetchResult.error instanceof Error &&
        fetchResult.error.name === 'AbortError';
      this.logger.warn(
        isTimeout
          ? `Compiler timed out after ${COMPILE_TIMEOUT_MS}ms`
          : `Compiler connection error: ${getErrorMessage(fetchResult.error)}`,
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

    return fetchResult.value;
  }

  private async parseCompilerResponse(res: Response): Promise<CompileResult> {
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
        if (isSuccess) {
          return {
            success: true,
            pdf: typeof json.pdf === 'string' ? json.pdf : '',
            synctex: typeof json.synctex === 'string' ? json.synctex : '',
            logs: typeof json.logs === 'string' ? json.logs : '',
            diagnostics: Array.isArray(json.diagnostics)
              ? (json.diagnostics as CompilerDiagnostic[])
              : undefined,
          };
        }
        return {
          success: false,
          error:
            typeof json.error === 'string'
              ? json.error
              : 'LaTeX compilation failed',
          fallback: false,
          pdf: typeof json.pdf === 'string' ? json.pdf : '',
          synctex: typeof json.synctex === 'string' ? json.synctex : '',
          logs: typeof json.logs === 'string' ? json.logs : '',
          diagnostics: Array.isArray(json.diagnostics)
            ? (json.diagnostics as CompilerDiagnostic[])
            : undefined,
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
        const rootContentStr = toContentString(rootPage.content);

        if (!source) {
          source = rootContentStr;
        }

        const childPages = rootPage.childPages || [];
        for (const child of childPages) {
          const childStr = toContentString(child.content);
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
    }

    // Extract citekeys from LaTeX source and child files to generate references.bib
    let bibContent: string | null = null;
    const combinedTexts = [source, ...Object.values(files)].join('\n');
    const citeKeys = extractCitationKeys(combinedTexts);
    if (citeKeys.length > 0 && this.libraryFacade) {
      let userId: string | undefined;
      if (pageId && this.prisma) {
        const page = await this.prisma.page.findUnique({
          where: { id: pageId },
          select: { authorId: true },
        });
        userId = page?.authorId;
      }
      if (!userId && projectId && this.prisma) {
        const project = await this.prisma.project.findUnique({
          where: { id: projectId },
          select: { createdById: true },
        });
        userId = project?.createdById;
      }

      if (userId) {
        try {
          const exportRes = await this.libraryFacade.exportBibByCitationKeys(
            userId,
            citeKeys,
          );
          if (exportRes && exportRes.content) {
            bibContent = exportRes.content;
          }
        } catch (err) {
          this.logger.warn(
            `Failed to auto-sync references.bib: ${getErrorMessage(err)}`,
          );
        }
      }
    }

    if (bibContent) {
      files['references.bib'] = bibContent;
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
      source,
      ...(Object.keys(files).length > 0 ? { files } : {}),
      ...(bibContent ? { bib_content: bibContent } : {}),
    };

    const fetchRes = await this.executeFetch(payload);
    if ('success' in fetchRes) {
      return fetchRes;
    }

    const compileRes = await this.parseCompilerResponse(fetchRes);

    if (compileRes.success && this.cache && source) {
      await this.cache.set(cacheKey, compileRes, 604800); // 7 days
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
              select: { id: true, name: true, email: true, avatar: true },
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
}

export const LatexService = CompilerService;
export type LatexService = CompilerService;
export const EngineService = CompilerService;
export type EngineService = CompilerService;
