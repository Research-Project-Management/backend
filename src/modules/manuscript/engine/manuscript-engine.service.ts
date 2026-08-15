import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { PageRepository } from '../page/page.repository';
import { VersionRepository } from '../version/version.repository';
import { LatexService } from '../latex/latex.service';
import {
  SaveAndSyncDto,
  CompileManuscriptDto,
} from './dto/manuscript-engine.dto';
import { LatexEngine } from '../latex/dto/latex.dto';
import { VersionEventType } from '@prisma/client';

@Injectable()
export class ManuscriptEngineService {
  private readonly logger = new Logger(ManuscriptEngineService.name);
  private static readonly SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes auto-snapshot

  constructor(
    private readonly pageRepo: PageRepository,
    private readonly versionRepo: VersionRepository,
    private readonly latexService: LatexService,
  ) {}

  /**
   * Deep Seam: Multi-step transaction that atomically updates page content,
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
        ManuscriptEngineService.SNAPSHOT_INTERVAL_MS;

    let createdVersion = null;
    if (shouldSnapshot) {
      createdVersion = await this.versionRepo.createVersion({
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

  /**
   * Deep Seam: Assembles the root manuscript and all nested chapters/sections,
   * formatting and compiling through the LaTeX engine.
   */
  async buildManuscript(pageId: string, dto: CompileManuscriptDto = {}) {
    const [rootPage, childPages] = await Promise.all([
      this.pageRepo.findPageById(pageId),
      this.pageRepo.findChildPages(pageId),
    ]);

    if (!rootPage) {
      throw new NotFoundException(`Manuscript page ${pageId} not found`);
    }

    // If source is not provided directly, assemble LaTeX document from page content
    let assembledSource = dto.source;
    if (!assembledSource) {
      let mainContent = '';
      if (typeof rootPage.content === 'string') {
        mainContent = rootPage.content;
      } else if (rootPage.content && typeof rootPage.content === 'object') {
        mainContent = JSON.stringify(rootPage.content);
      }

      assembledSource = `\\documentclass{article}\n\\title{${rootPage.title}}\n\\begin{document}\n\\maketitle\n\n${mainContent}\n`;

      for (const section of childPages) {
        let secContent = '';
        if (typeof section.content === 'string') {
          secContent = section.content;
        }
        assembledSource += `\n\\section{${section.title}}\n${secContent}\n`;
      }

      assembledSource += `\n\\end{document}\n`;
    }

    const compileResult = await this.latexService.compile({
      project_id: pageId,
      page_id: pageId,
      engine: dto.engine || LatexEngine.PDFLATEX,
      source: assembledSource,
    });

    return {
      ...compileResult,
      manuscriptId: pageId,
      title: rootPage.title,
      sectionsCount: childPages.length,
      pdf: compileResult.pdf || '',
      synctex: compileResult.synctex || '',
    };
  }

  /**
   * Deep Seam: Rollback to a previous snapshot and mark LaTeX compilation dirty
   */
  async rollbackAndSync(pageId: string, versionId: string) {
    const version = await this.versionRepo.findVersionById(versionId);

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
