import {
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PageRepository } from '../page/page.repository';
import { CompileLatexDto, SyncIncrementalDto } from './dto/latex.dto';
import { getErrorMessage, tryCatch } from '@/core/utils/error.util';
import { RedisCacheService } from '@/core/cache/redis-cache.service';
import { DOCUMENT_REDIS_KEYS } from '../constants/redis-keys.constant';
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

@Injectable()
export class LatexService {
  private readonly latexUrl: string;
  private readonly logger = new Logger(LatexService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly pageRepo: PageRepository,
    @Optional() private readonly cache?: RedisCacheService,
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

  async compile(dto: CompileLatexDto): Promise<CompileResult> {
    const source = dto.source || '';
    const sourceHash = this.hashSource(source);
    const cacheKey = DOCUMENT_REDIS_KEYS.latex(sourceHash);

    if (this.cache && dto.use_cache && source) {
      const cached = await this.cache.get<CompileResult>(cacheKey);
      if (cached && cached.success) {
        return cached;
      }
    }

    const payload = {
      project_id: dto.project_id || dto.page_id,
      main_file: dto.main_file,
      engine: dto.engine || 'pdflatex',
      draft: dto.draft ?? false,
      use_cache: dto.use_cache ?? true,
      source,
    };

    const fetchResult = await tryCatch(
      fetch(`${this.latexUrl}/compile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }),
    );

    if (!fetchResult.ok) {
      this.logger.warn(
        `Latex compiler connection error: ${getErrorMessage(fetchResult.error)}`,
      );
      return {
        success: false,
        error: 'LaTeX compiler unreachable',
        fallback: true,
        pdf: '',
        synctex: '',
      };
    }

    const res = fetchResult.value;
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
    let compileRes: CompileResult | null = null;

    if (contentType.includes('application/json')) {
      const jsonResult = await tryCatch(
        res.json() as Promise<Record<string, unknown>>,
      );
      if (jsonResult.ok) {
        const json = jsonResult.value;
        compileRes = {
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
        compileRes = { success: true, pdf: pdfBase64, synctex: '' };
      }
    }

    if (compileRes) {
      if (this.cache && source) {
        await this.cache.set(cacheKey, compileRes, 604800); // 7 days
      }
      return compileRes;
    }

    return {
      success: false,
      error: 'LaTeX compilation fallback',
      fallback: true,
      pdf: '',
      synctex: '',
    };
  }

  async syncProject(rootPageId: string) {
    const [rootPage, childPages] = await Promise.all([
      this.pageRepo.findPageById(rootPageId),
      this.pageRepo.findChildPages(rootPageId),
    ]);

    if (!rootPage) {
      throw new NotFoundException('Page not found');
    }

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

    const rootPage = await this.pageRepo.findPageById(rootPageId);

    if (!rootPage) {
      throw new NotFoundException('Page not found');
    }

    return {
      synced: dirtyIds,
      total: dirtyIds.length,
    };
  }
}
