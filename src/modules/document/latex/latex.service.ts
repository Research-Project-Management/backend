import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@/core/database/prisma.service';
import { CompileLatexDto, SyncIncrementalDto } from './dto/latex.dto';
import { getErrorMessage, tryCatch } from '@/core/utils/error.util';

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
    private readonly prisma: PrismaService,
  ) {
    this.latexUrl =
      this.configService.get<string>('LATEX_URL') || 'http://localhost:2918';
  }

  async compile(dto: CompileLatexDto): Promise<CompileResult> {
    const payload = {
      project_id: dto.project_id || dto.page_id,
      main_file: dto.main_file,
      engine: dto.engine || 'pdflatex',
      draft: dto.draft ?? false,
      use_cache: dto.use_cache ?? true,
      source: dto.source || '',
    };

    const result = await tryCatch(
      fetch(`${this.latexUrl}/compile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }),
    );

    if (result.ok && result.value.ok) {
      const res = result.value;
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
    } else if (!result.ok) {
      this.logger.warn(
        `Latex compiler proxy warning: ${getErrorMessage(result.error)}`,
      );
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
      this.prisma.page.findUnique({
        where: { id: rootPageId },
      }),
      this.prisma.page.findMany({
        where: { parentPageId: rootPageId, deletedAt: null },
      }),
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

    const rootPage = await this.prisma.page.findUnique({
      where: { id: rootPageId },
    });

    if (!rootPage) {
      throw new NotFoundException('Page not found');
    }

    return {
      synced: dirtyIds,
      total: dirtyIds.length,
    };
  }
}
