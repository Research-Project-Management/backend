import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { PageService } from '../page/page.service';
import { HistoryService } from '../history/history.service';
import { LatexService } from '../latex/latex.service';
import { SaveAndSyncDto, CompileDocumentDto } from './dto/engine.dto';
import { LatexEngine } from '../latex/dto/latex.dto';
import { VersionEventType } from '@prisma/client';

@Injectable()
export class EngineService {
  private readonly logger = new Logger(EngineService.name);
  private static readonly SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes auto-snapshot

  constructor(
    private readonly prisma: PrismaService,
    private readonly pageService: PageService,
    private readonly historyService: HistoryService,
    private readonly latexService: LatexService,
  ) {}

  /**
   * Atomically updates page content and creates a version snapshot (if needed)
   * using prisma.$transaction, then triggers LaTeX tree synchronization.
   */
  async saveAndSync(pageId: string, userId: string, dto: SaveAndSyncDto) {
    const page = await this.pageService.findPageWithVersions(pageId);

    if (!page) {
      throw new NotFoundException(`Page ${pageId} not found`);
    }

    const lastSnapshot = page.versions[0];
    const shouldSnapshot =
      dto.createSnapshot ||
      !lastSnapshot ||
      Date.now() - new Date(lastSnapshot.createdAt).getTime() >
        EngineService.SNAPSHOT_INTERVAL_MS;

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

    // Sync project structure for compilation (outside transaction — non-critical)
    const syncResult = await this.latexService.syncProject(
      page.parentPageId || pageId,
    );

    return {
      page: updatedPage,
      snapshotCreated: !!createdVersion,
      version: createdVersion,
      latexSync: syncResult,
    };
  }

  private assembleLatexSource(
    title: string,
    rootContent: unknown,
    childPages: Array<{ title: string; content?: unknown }>,
  ): string {
    let mainContent = '';
    if (typeof rootContent === 'string') {
      mainContent = rootContent;
    } else if (rootContent && typeof rootContent === 'object') {
      mainContent = JSON.stringify(rootContent);
    }

    let source = `\\documentclass{article}\n\\title{${title}}\n\\begin{document}\n\\maketitle\n\n${mainContent}\n`;

    for (const section of childPages) {
      let secContent = '';
      if (typeof section.content === 'string') {
        secContent = section.content;
      } else if (section.content && typeof section.content === 'object') {
        secContent = JSON.stringify(section.content);
      }
      source += `\n\\section{${section.title}}\n${secContent}\n`;
    }

    source += `\n\\end{document}\n`;
    return source;
  }

  /**
   * Assembles the root document and all nested chapters/sections,
   * formatting and compiling through the LaTeX engine.
   */
  async buildDocument(pageId: string, dto: CompileDocumentDto = {}) {
    const rootPage = await this.pageService.findPageById(pageId);

    if (!rootPage) {
      throw new NotFoundException(`Document page ${pageId} not found`);
    }

    const childPages = rootPage.childPages || [];
    const assembledSource =
      dto.source ||
      this.assembleLatexSource(rootPage.title, rootPage.content, childPages);

    const compileResult = await this.latexService.compile({
      project_id: pageId,
      page_id: pageId,
      engine: dto.engine || LatexEngine.PDFLATEX,
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
   * Rollback to a previous snapshot and mark LaTeX compilation dirty
   */
  async rollbackAndSync(pageId: string, versionId: string) {
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

    const syncResult = await this.latexService.syncProject(pageId);

    return {
      restoredPage: updated,
      versionId,
      latexSync: syncResult,
    };
  }
}
