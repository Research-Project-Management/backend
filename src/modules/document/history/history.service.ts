import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Optional,
} from '@nestjs/common';
import { HistoryRepository } from './history.repository';
import { PageService } from '../core/core.service';
import { CreateVersionDto } from './dto/history.dto';
import { VersionEventType, Prisma } from '@prisma/client';
import { tryCatchSync } from '@/core/utils/error.util';
import { RedisCacheService } from '@/core/cache/redis.service';
import { DOCUMENT_REDIS_KEYS } from '../core/constants/redis-keys.constant';

@Injectable()
export class HistoryService {
  constructor(
    private readonly historyRepo: HistoryRepository,
    private readonly pageService: PageService,
    @Optional() private readonly cache?: RedisCacheService,
  ) {}

  private async invalidateVersionCache(pageId: string) {
    if (!this.cache) return;
    await Promise.all([
      this.cache.del(DOCUMENT_REDIS_KEYS.pageVersions(pageId)),
      this.cache.del(DOCUMENT_REDIS_KEYS.page(pageId)),
    ]);
  }

  private async invalidatePageTreeCache(projectId: string | null | undefined) {
    if (!this.cache || !projectId) return;
    await this.cache.del(DOCUMENT_REDIS_KEYS.projectTree(projectId));
  }

  async getVersions(pageId: string) {
    const cacheKey = DOCUMENT_REDIS_KEYS.pageVersions(pageId);

    if (this.cache) {
      return this.cache.wrap(
        cacheKey,
        async () => {
          const versions = await this.historyRepo.findPageVersions(pageId);
          return { versions };
        },
        3600,
      );
    }

    const versions = await this.historyRepo.findPageVersions(pageId);
    return { versions };
  }

  async getVersion(pageId: string, versionId: string) {
    const version = await this.historyRepo.findVersionById(versionId);
    if (!version || version.pageId !== pageId) {
      throw new NotFoundException('Version not found');
    }
    return { version };
  }

  async createVersion(pageId: string, userId: string, dto: CreateVersionDto) {
    const page = await this.pageService.findPageById(pageId);

    if (!page) {
      throw new NotFoundException('Page not found');
    }

    const effectiveProjectPageId = dto.projectPageId || dto.rootPageId || null;
    const contentToSave =
      dto.content !== undefined
        ? dto.content
        : typeof page.content === 'string'
          ? page.content
          : JSON.stringify(page.content || '');

    // Deduplicate auto_save if content has not changed from the latest snapshot
    if (dto.eventType === VersionEventType.auto_save) {
      const latestList = await this.historyRepo.findPageVersions(pageId);
      if (latestList.length > 0) {
        const latestFull = await this.historyRepo.findVersionById(
          latestList[0].id,
        );
        if (latestFull && latestFull.content === contentToSave) {
          return { version: latestFull };
        }
      }
    }

    const version = await this.historyRepo.createVersion({
      page: { connect: { id: pageId } },
      projectPageId: effectiveProjectPageId,
      title: dto.title || page.title,
      content: contentToSave,
      label: dto.label || '',
      savedById: userId,
      eventType: dto.eventType || VersionEventType.manual_save,
      fileName: dto.fileName || page.title,
    });

    await this.invalidateVersionCache(pageId);

    return { version };
  }

  async restoreVersion(pageId: string, versionId: string) {
    const version = await this.historyRepo.findVersionById(versionId);

    if (!version) {
      throw new NotFoundException('Version not found');
    }

    if (version.pageId !== pageId) {
      throw new BadRequestException(
        'Version does not belong to the specified page',
      );
    }

    let parsedContent: Prisma.InputJsonValue | string | null = version.content;
    if (
      typeof version.content === 'string' &&
      version.content.startsWith('{')
    ) {
      const parsed = tryCatchSync<Prisma.InputJsonValue>(
        () => JSON.parse(version.content as string) as Prisma.InputJsonValue,
      );
      if (parsed.ok) {
        parsedContent = parsed.value;
      }
    }

    // Route through PageService (correct domain) — ensures cache + event are handled
    const updateRes = await this.pageService.updatePage(pageId, {
      content: parsedContent !== null ? parsedContent : undefined,
      title: version.title || undefined,
    });
    const page = updateRes?.page;
    if (!page) {
      throw new NotFoundException('Failed to restore page: page not found');
    }

    const pageContentStr =
      typeof page.content === 'string'
        ? page.content
        : JSON.stringify(page.content || '');

    // Append-only history pattern: record a restore event snapshot so we never lose history
    await this.historyRepo.createVersion({
      page: { connect: { id: pageId } },
      projectPageId: page.parentPageId || page.id,
      title: page.title,
      content: pageContentStr,
      label: `Restored to "${version.label || version.title || 'Previous version'}"`,
      savedById: version.savedById,
      eventType: VersionEventType.restore,
      fileName: version.fileName || page.title,
    });

    // Invalidate both version cache and page/tree cache
    await Promise.all([
      this.invalidateVersionCache(pageId),
      this.invalidatePageTreeCache(page?.projectId),
    ]);

    return {
      message: 'Version restored successfully',
      page,
      restored: [
        {
          pageId: page.id,
          content: pageContentStr,
          title: page.title,
        },
      ],
    };
  }

  async deleteVersion(versionId: string, pageId: string) {
    const version = await this.historyRepo.findVersionById(versionId);
    if (!version) {
      throw new NotFoundException('Version not found');
    }

    if (version.pageId !== pageId) {
      throw new BadRequestException(
        'Version does not belong to the specified page',
      );
    }

    await this.historyRepo.deleteVersion(versionId);
    await this.invalidateVersionCache(version.pageId);

    return { message: 'Version deleted successfully' };
  }

  async findVersionById(versionId: string) {
    return this.historyRepo.findVersionById(versionId);
  }

  async getHistory(pageId: string) {
    const { versions } = await this.getVersions(pageId);
    return { history: versions, events: versions };
  }

  /**
   * Computes line-by-line visual diff comparing two saved snapshot versions.
   */
  async compareVersions(
    pageId: string,
    fromVersionId: string,
    toVersionId: string,
  ) {
    const fromVer = await this.historyRepo.findVersionById(fromVersionId);
    if (!fromVer || fromVer.pageId !== pageId) {
      throw new NotFoundException(`Source version ${fromVersionId} not found`);
    }

    const toVer = await this.historyRepo.findVersionById(toVersionId);
    if (!toVer || toVer.pageId !== pageId) {
      throw new NotFoundException(`Target version ${toVersionId} not found`);
    }

    const fromText = fromVer.content || '';
    const toText = toVer.content || '';

    const fromLines = fromText.split('\n');
    const toLines = toText.split('\n');

    const chunks: Array<{
      type: 'added' | 'deleted' | 'unchanged';
      value: string;
      linesCount: number;
    }> = [];
    let addedLines = 0;
    let deletedLines = 0;
    let unchangedLines = 0;

    const lcs = this.computeLcs(fromLines, toLines);
    let i = 0;
    let j = 0;
    let l = 0;

    while (i < fromLines.length || j < toLines.length) {
      if (
        l < lcs.length &&
        i < fromLines.length &&
        fromLines[i] === lcs[l] &&
        j < toLines.length &&
        toLines[j] === lcs[l]
      ) {
        const start = i;
        while (
          l < lcs.length &&
          i < fromLines.length &&
          j < toLines.length &&
          fromLines[i] === lcs[l] &&
          toLines[j] === lcs[l]
        ) {
          i++;
          j++;
          l++;
        }
        const slice = fromLines.slice(start, i);
        chunks.push({
          type: 'unchanged',
          value: slice.join('\n'),
          linesCount: slice.length,
        });
        unchangedLines += slice.length;
      } else {
        const delStart = i;
        while (
          i < fromLines.length &&
          (l >= lcs.length || fromLines[i] !== lcs[l])
        ) {
          i++;
        }
        if (i > delStart) {
          const slice = fromLines.slice(delStart, i);
          chunks.push({
            type: 'deleted',
            value: slice.join('\n'),
            linesCount: slice.length,
          });
          deletedLines += slice.length;
        }

        const addStart = j;
        while (
          j < toLines.length &&
          (l >= lcs.length || toLines[j] !== lcs[l])
        ) {
          j++;
        }
        if (j > addStart) {
          const slice = toLines.slice(addStart, j);
          chunks.push({
            type: 'added',
            value: slice.join('\n'),
            linesCount: slice.length,
          });
          addedLines += slice.length;
        }
      }
    }

    return {
      fromVersionId,
      toVersionId,
      fromLabel: fromVer.label || fromVer.createdAt.toISOString(),
      toLabel: toVer.label || toVer.createdAt.toISOString(),
      chunks,
      stats: {
        addedLines,
        deletedLines,
        unchangedLines,
      },
    };
  }

  private computeLcs(a: string[], b: string[]): string[] {
    const m = a.length;
    const n = b.length;
    if (m * n > 4_000_000) {
      return a.filter((line) => b.includes(line));
    }

    const dp: number[][] = Array.from({ length: m + 1 }, () =>
      new Array(n + 1).fill(0),
    );
    for (let i = 0; i < m; i++) {
      for (let j = 0; j < n; j++) {
        if (a[i] === b[j]) {
          dp[i + 1][j + 1] = dp[i][j] + 1;
        } else {
          dp[i + 1][j + 1] = Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
      }
    }

    const result: string[] = [];
    let i = m;
    let j = n;
    while (i > 0 && j > 0) {
      if (a[i - 1] === b[j - 1]) {
        result.unshift(a[i - 1]);
        i--;
        j--;
      } else if (dp[i - 1][j] >= dp[i][j - 1]) {
        i--;
      } else {
        j--;
      }
    }
    return result;
  }
}
