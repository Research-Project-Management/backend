/**
 * modules/pages/clsi/services/wordcount.service.ts
 * Multi-file TeX word count service (TeXcount).
 */

import { Injectable } from '@nestjs/common';
import { ClsiWordCountDto } from '../dto/compile.dto';
import { WordCountStats } from '../domain/ports';
import { TexWordCounter } from '../domain/word-count.engine';
import { CompileSourceService } from './compile-source.service';

@Injectable()
export class WordCountService {
  private readonly wordCounter = new TexWordCounter();

  constructor(private readonly compileSource: CompileSourceService) {}

  public async count(
    dto: ClsiWordCountDto,
    authorizedSpaceId?: string,
  ): Promise<{
    success: boolean;
    stats?: WordCountStats;
    error?: string;
  }> {
    const { spaceId: resolvedSpaceId, pageId: resolvedPageId } =
      await this.compileSource.resolvePageCompileContext(
        dto,
        authorizedSpaceId,
      );
    const spaceId =
      resolvedSpaceId && resolvedSpaceId !== 'default'
        ? resolvedSpaceId
        : undefined;
    const targetPageId = resolvedPageId ?? dto.pageId;
    const scratchTargetId = targetPageId || spaceId || 'default';

    if (
      (dto.files && Object.keys(dto.files).length > 0) ||
      (spaceId && spaceId !== 'default' && !dto.source)
    ) {
      let stringFiles: Record<string, string> = {};
      let rootFile = dto.filename || 'main.tex';

      if (spaceId && spaceId !== 'default') {
        try {
          const plan = await this.compileSource.planFiles(
            spaceId,
            {
              spaceId,
              pageId: targetPageId,
              files: dto.files,
            },
            targetPageId,
          );
          rootFile = plan.mainFile || rootFile;
          const hydrated = await this.compileSource.hydrateFiles(
            spaceId,
            plan,
            scratchTargetId,
          );
          for (const [filePath, val] of Object.entries(hydrated)) {
            if (typeof val === 'string') {
              stringFiles[filePath] = val;
            }
          }
        } catch {
          if (dto.files) {
            stringFiles = { ...dto.files };
          }
        }
      } else if (dto.files) {
        stringFiles = { ...dto.files };
      }

      const stats = this.wordCounter.countProject(stringFiles, {
        rootFile,
        includeBib: dto.includeBib,
      });

      if (dto.source !== undefined) {
        const singleStats = this.wordCounter.count(
          dto.source,
          dto.filename || rootFile,
          { includeBib: dto.includeBib },
        );
        return {
          success: true,
          stats: {
            ...singleStats,
            perFileStats: stats.perFileStats,
          },
        };
      }

      return {
        success: true,
        stats,
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

    const stats = this.wordCounter.count(
      dto.source,
      dto.filename || 'document.tex',
      { includeBib: dto.includeBib },
    );

    if (spaceId && spaceId !== 'default') {
      try {
        const plan = await this.compileSource.planFiles(
          spaceId,
          {
            spaceId,
            pageId: targetPageId,
            files: dto.files,
          },
          targetPageId,
        );
        const hydrated = await this.compileSource.hydrateFiles(
          spaceId,
          plan,
          scratchTargetId,
        );
        const stringFiles: Record<string, string> = {};
        for (const [filePath, val] of Object.entries(hydrated)) {
          if (typeof val === 'string') {
            stringFiles[filePath] = val;
          }
        }
        if (Object.keys(stringFiles).length > 0) {
          const projectStats = this.wordCounter.countProject(stringFiles, {
            rootFile: plan.mainFile,
            includeBib: dto.includeBib,
          });
          stats.perFileStats = projectStats.perFileStats;
        }
      } catch {
        // Ignore hydration failure when counting single source
      }
    }

    return {
      success: true,
      stats,
    };
  }
}
