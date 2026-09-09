import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PageService } from '../page/page.service';
import { CompileLatexDto, SyncIncrementalDto } from './dto/latex.dto';
import { getErrorMessage, tryCatch } from '@/core/utils/error.util';
import { RedisCacheService } from '@/core/cache/redis-cache.service';
import { DOCUMENT_REDIS_KEYS } from '../constants/redis-keys.constant';
import { ExportsService } from '../../library/exports/exports.service';
import { PrismaService } from '@/core/database/prisma.service';
import * as crypto from 'crypto';

export type CompileResult =
  | {
      success: true;
      pdf: string;
      synctex?: string;
      message?: string;
      logs?: string;
    }
  | {
      success: false;
      error: string;
      fallback: boolean;
      pdf?: string;
      synctex?: string;
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

@Injectable()
export class LatexService {
  private readonly latexUrl: string;
  private readonly logger = new Logger(LatexService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly pageService: PageService,
    @Optional() private readonly cache?: RedisCacheService,
    @Optional() private readonly exportsService?: ExportsService,
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
          ? `LaTeX compiler timed out after ${COMPILE_TIMEOUT_MS}ms`
          : `Latex compiler connection error: ${getErrorMessage(fetchResult.error)}`,
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
        error: `LaTeX compiler returned HTTP ${res.status}`,
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
        return {
          success: true,
          pdf: typeof json.pdf === 'string' ? json.pdf : '',
          synctex: typeof json.synctex === 'string' ? json.synctex : '',
          logs: typeof json.logs === 'string' ? json.logs : undefined,
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
    const pageId = dto.page_id || dto.pageId;
    const projectId = dto.project_id || dto.projectId;

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

    const source = dto.source || '';
    const sourceHash = this.hashSource(source);
    const cacheKey = DOCUMENT_REDIS_KEYS.latex(sourceHash);

    if (dto.use_cache && source) {
      const cached = await this.getFromCache(cacheKey);
      if (cached) {
        return cached;
      }
    }

    // Extract citekeys from LaTeX source and generate references.bib
    let bibContent: string | null = null;
    const citeKeys = extractCitationKeys(source);
    if (citeKeys.length > 0 && this.exportsService) {
      let workspaceId = dto.workspaceId;
      if (!workspaceId && pageId && this.prisma) {
        const page = await this.prisma.page.findUnique({
          where: { id: pageId },
          select: { workspaceId: true },
        });
        workspaceId = page?.workspaceId;
      }
      if (!workspaceId && projectId && this.prisma) {
        const project = await this.prisma.project.findUnique({
          where: { id: projectId },
          select: { workspaceId: true },
        });
        workspaceId = project?.workspaceId;
      }

      if (workspaceId) {
        try {
          const exportRes = await this.exportsService.exportByCitationKeys(
            workspaceId,
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

    const files: Record<string, string> = {};
    if (bibContent) {
      files['references.bib'] = bibContent;
    }

    const payload = {
      project_id: dto.project_id || dto.page_id,
      main_file: dto.main_file,
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

  async syncProject(rootPageId: string) {
    const rootPage = await this.pageService.findPageById(rootPageId);

    if (!rootPage) {
      throw new NotFoundException('Page not found');
    }

    const childPages = rootPage.childPages || [];

    return {
      ok: true,
      synced: 1 + childPages.length,
      rootPageId,
    };
  }

  async syncIncremental(rootPageId: string, dto: SyncIncrementalDto) {
    const dirtyIds = dto.dirtyFileIds || [];
    if (dirtyIds.length === 0) {
      return {
        synced: [],
        total: 0,
      };
    }

    const rootPage = await this.pageService.findPageById(rootPageId);

    if (!rootPage) {
      throw new NotFoundException('Page not found');
    }

    return {
      synced: dirtyIds,
      total: dirtyIds.length,
    };
  }
}
