import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Optional,
  Logger,
} from '@nestjs/common';
import { HistoryRepository } from './history.repository';
import { PageService } from '../page/page.service';
import {
  CreateVersionDto,
  UpdateVersionDto,
  VersionQueryDto,
  VersionDiffResult,
} from './dto/history.dto';
import { VersionEventType, Prisma } from '@prisma/client';
import { tryCatchSync } from '@/core/utils/error.util';
import { RedisCacheService } from '@/core/cache/redis.service';
import { DOCUMENT_REDIS_KEYS } from '../page/constants/page-redis-keys.constant';
import { YjsDocumentManager } from '../collaboration/yjs-document.manager';
import { CollaborationGateway } from '../collaboration/collaboration.gateway';
import { VersionQueryOptions } from '../page/types/page-repository.interface';
import { toContentString } from '../page/utils/page.utils';

@Injectable()
export class HistoryService {
  private readonly logger = new Logger(HistoryService.name);

  constructor(
    private readonly historyRepo: HistoryRepository,
    private readonly pageService: PageService,
    @Optional() private readonly cache?: RedisCacheService,
    @Optional() private readonly yjsManager?: YjsDocumentManager,
    @Optional() private readonly collaborationGateway?: CollaborationGateway,
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

  async getVersions(pageId: string, options?: VersionQueryDto) {
    const isDefaultQuery =
      !options || (!options.cursor && !options.eventType && !options.limit);
    const cacheKey = DOCUMENT_REDIS_KEYS.pageVersions(pageId);

    if (this.cache && isDefaultQuery) {
      return this.cache.wrap(
        cacheKey,
        async () => {
          return this.historyRepo.findPageVersions(pageId, options);
        },
        3600,
      );
    }

    return this.historyRepo.findPageVersions(pageId, options);
  }

  async getVersion(pageId: string, versionId: string) {
    const version = await this.historyRepo.findVersionById(versionId);
    if (!version || version.pageId !== pageId) {
      throw new NotFoundException('Version not found');
    }
    return { version };
  }

  async updateVersion(
    pageId: string,
    versionId: string,
    dto: UpdateVersionDto,
  ) {
    const existing = await this.historyRepo.findVersionById(versionId);
    if (!existing) {
      throw new NotFoundException('Version not found');
    }

    // Allow update if pageId matches version's pageId, projectPageId, or page's projectId
    const existingPage = (existing as any).page;
    if (
      existing.pageId !== pageId &&
      existing.projectPageId !== pageId &&
      existingPage?.projectId !== pageId
    ) {
      const targetPage = await this.pageService.findPageById(pageId);
      if (
        !targetPage ||
        (existingPage?.projectId &&
          targetPage.projectId !== existingPage.projectId)
      ) {
        throw new NotFoundException('Version not found for this page context');
      }
    }

    const cleanLabel =
      dto.label !== undefined
        ? dto.label.trim() === ''
          ? null
          : dto.label.trim()
        : undefined;

    const updated = await this.historyRepo.updateVersion(versionId, {
      ...(cleanLabel !== undefined ? { label: cleanLabel } : {}),
      ...(dto.title !== undefined ? { title: dto.title } : {}),
    });

    await this.invalidateVersionCache(existing.pageId);
    if (existing.projectPageId) {
      await this.invalidateVersionCache(existing.projectPageId);
    }
    if (pageId !== existing.pageId) {
      await this.invalidateVersionCache(pageId);
    }

    return { version: updated };
  }

  async createVersion(pageId: string, userId: string, dto: CreateVersionDto) {
    const page = await this.pageService.findPageById(pageId);

    if (!page) {
      throw new NotFoundException('Page not found');
    }

    const effectiveProjectPageId = dto.projectPageId || dto.rootPageId || null;
    const contentToSave =
      dto.content !== undefined ? dto.content : toContentString(page.content);

    // Deduplicate auto_save if content has not changed from the latest snapshot
    if (dto.eventType === VersionEventType.auto_save) {
      const latestResult = await this.historyRepo.findPageVersions(pageId, {
        limit: 1,
      });
      if (latestResult.versions.length > 0) {
        const latestFull = await this.historyRepo.findVersionById(
          latestResult.versions[0].id,
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
      label: dto.label && dto.label.trim() ? dto.label.trim() : null,
      savedById: userId,
      eventType: dto.eventType || VersionEventType.manual_save,
      fileName: dto.fileName || page.title,
    });

    await this.invalidateVersionCache(pageId);

    return { version };
  }

  async restoreVersion(pageId: string, versionId: string, userId?: string) {
    const version = await this.historyRepo.findVersionById(versionId);

    if (!version) {
      throw new NotFoundException('Version not found');
    }

    if (version.pageId !== pageId) {
      throw new BadRequestException(
        'Version does not belong to the specified page',
      );
    }

    const contentStr =
      typeof version.content === 'string'
        ? version.content
        : JSON.stringify(version.content || '');

    // 1. Realtime CRDT Collaborative Restore (Overleaf-grade):
    // Injects a replacement transaction directly into in-memory Y.Doc,
    // updates Redis L2 snapshot, and broadcasts update binary to all online collaborators.
    if (this.yjsManager) {
      try {
        const update = await this.yjsManager.replaceText(
          pageId,
          contentStr,
          userId,
        );
        if (update && this.collaborationGateway) {
          this.collaborationGateway.broadcastYjsUpdate(pageId, update);
        }
      } catch (err: any) {
        this.logger.warn(
          `[HistoryService] Failed to perform Yjs collaborative restore for ${pageId}: ${err?.message || err}`,
        );
      }
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

    // 2. Persist to PostgreSQL via PageService
    const updateRes = await this.pageService.updatePage(pageId, {
      content: parsedContent !== null ? parsedContent : undefined,
      title: version.title || undefined,
    });
    const page = updateRes?.page;
    if (!page) {
      throw new NotFoundException('Failed to restore page: page not found');
    }

    const pageContentStr = toContentString(page.content);

    // 3. Append-only history pattern: record a restore event snapshot so we never lose history
    await this.historyRepo.createVersion({
      page: { connect: { id: pageId } },
      projectPageId: page.parentPageId || page.id,
      title: page.title,
      content: pageContentStr,
      label: `Restored to "${version.label || version.title || 'Previous version'}"`,
      savedById: userId || version.savedById,
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
    const result = await this.getVersions(pageId);
    return { history: result.versions, events: result.versions };
  }

  /**
   * Computes line-by-line visual diff comparing two saved snapshot versions,
   * or comparing a snapshot against the current draft ('current').
   */
  async compareVersions(
    pageId: string,
    fromVersionId: string,
    toVersionId: string,
  ): Promise<VersionDiffResult> {
    let fromText = '';
    let fromLabel = '';

    if (fromVersionId === 'current') {
      fromLabel = 'Current Draft';
      const liveText = this.yjsManager?.getText(pageId);
      if (liveText !== undefined && liveText !== '') {
        fromText = liveText;
      } else {
        const page = await this.pageService.findPageById(pageId);
        if (!page) throw new NotFoundException(`Page ${pageId} not found`);
        fromText = toContentString(page.content);
      }
    } else {
      const fromVer = await this.historyRepo.findVersionById(fromVersionId);
      if (!fromVer || fromVer.pageId !== pageId) {
        throw new NotFoundException(
          `Source version ${fromVersionId} not found`,
        );
      }
      fromText = fromVer.content || '';
      fromLabel = fromVer.label || fromVer.createdAt.toISOString();
    }

    let toText = '';
    let toLabel = '';

    if (toVersionId === 'current') {
      toLabel = 'Current Draft';
      const liveText = this.yjsManager?.getText(pageId);
      if (liveText !== undefined && liveText !== '') {
        toText = liveText;
      } else {
        const page = await this.pageService.findPageById(pageId);
        if (!page) throw new NotFoundException(`Page ${pageId} not found`);
        toText = toContentString(page.content);
      }
    } else {
      const toVer = await this.historyRepo.findVersionById(toVersionId);
      if (!toVer || toVer.pageId !== pageId) {
        throw new NotFoundException(`Target version ${toVersionId} not found`);
      }
      toText = toVer.content || '';
      toLabel = toVer.label || toVer.createdAt.toISOString();
    }

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
      fromLabel,
      toLabel,
      fromContent: fromText,
      toContent: toText,
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
