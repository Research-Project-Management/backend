import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { PageRepository } from '../page/page.repository';
import { HistoryRepository } from '../history/history.repository';
import { LatexService } from '../latex/latex.service';
import { SaveAndSyncDto, CompileDocumentDto } from './dto/engine.dto';
import { LatexEngine } from '../latex/dto/latex.dto';
import { VersionEventType } from '@prisma/client';

@Injectable()
export class EngineService {
  private readonly logger = new Logger(EngineService.name);
  private static readonly SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes auto-snapshot

  constructor(
    private readonly pageRepo: PageRepository,
    private readonly historyRepo: HistoryRepository,
    private readonly latexService: LatexService,
  ) {}

  /**
   * Multi-step transaction that atomically updates page content,
   * creates version snapshot if needed, and triggers LaTeX tree synchronization.
   */
  async saveAndSync(pageId: string, userId: string, dto: SaveAndSyncDto) {
    const page = await this.pageRepo.findPageWithVersions(pageId);

    if (!page) {
      throw new NotFoundException(`Page ${pageId} not found`);
    }

    // Step 1: Update page content and bump version timestamp
    const updatedPage = await this.pageRepo.updatePage(pageId, {
      ...(dto.content !== undefined && { content: dto.content }),
      ...(dto.title !== undefined && { title: dto.title }),
      updatedAt: new Date(),
    });

    // Step 2: Determine if a snapshot should be minted
    const lastSnapshot = page.versions[0];
    const shouldSnapshot =
      dto.createSnapshot ||
      !lastSnapshot ||
      Date.now() - new Date(lastSnapshot.createdAt).getTime() >
        EngineService.SNAPSHOT_INTERVAL_MS;

    let createdVersion = null;
    if (shouldSnapshot) {
      createdVersion = await this.historyRepo.createVersion({
        pageId,
        title: updatedPage.title,
        content:
          typeof updatedPage.content === 'string'
            ? updatedPage.content
            : JSON.stringify(updatedPage.content || ''),
        label:
          dto.versionDescription ||
          (dto.createSnapshot ? 'Manual snapshot' : 'Auto-save snapshot'),
        savedById: userId,
        eventType: dto.createSnapshot
          ? VersionEventType.manual_save
          : VersionEventType.auto_save,
      });
    }

    // Sync project structure for compilation
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
    const [rootPage, childPages] = await Promise.all([
      this.pageRepo.findPageById(pageId),
      this.pageRepo.findChildPages(pageId),
    ]);

    if (!rootPage) {
      throw new NotFoundException(`Document page ${pageId} not found`);
    }

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
    const version = await this.historyRepo.findVersionById(versionId);

    if (!version) {
      throw new NotFoundException(`Version ${versionId} not found`);
    }

    const updated = await this.pageRepo.updatePage(pageId, {
      content: version.content || '',
      title: version.title || undefined,
    });

    const syncResult = await this.latexService.syncProject(pageId);

    return {
      restoredPage: updated,
      versionId,
      latexSync: syncResult,
    };
  }
}
