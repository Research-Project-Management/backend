import { Injectable, NotFoundException, Optional } from '@nestjs/common';
import { HistoryRepository } from './history.repository';
import { CreateVersionDto } from './dto/history.dto';
import { VersionEventType, Prisma } from '@prisma/client';
import { tryCatchSync } from '@/core/utils/error.util';
import { RedisCacheService } from '@/core/cache/redis-cache.service';
import { DOCUMENT_REDIS_KEYS } from '../constants/redis-keys.constant';

@Injectable()
export class HistoryService {
  constructor(
    private readonly historyRepo: HistoryRepository,
    @Optional() private readonly cache?: RedisCacheService,
  ) {}

  private async invalidateVersionCache(pageId: string) {
    if (!this.cache) return;
    await Promise.all([
      this.cache.del(DOCUMENT_REDIS_KEYS.pageVersions(pageId)),
      this.cache.del(DOCUMENT_REDIS_KEYS.page(pageId)),
    ]);
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

  async createVersion(pageId: string, userId: string, dto: CreateVersionDto) {
    const page = await this.historyRepo.findPageById(pageId);

    if (!page) {
      throw new NotFoundException('Page not found');
    }

    const version = await this.historyRepo.createVersion({
      page: { connect: { id: pageId } },
      projectPageId: dto.projectPageId || null,
      title: dto.title || page.title,
      content:
        dto.content !== undefined
          ? dto.content
          : typeof page.content === 'string'
            ? page.content
            : JSON.stringify(page.content || ''),
      label: dto.label || '',
      savedById: userId,
      eventType: dto.eventType || VersionEventType.manual_save,
      fileName: dto.fileName || '',
    });

    await this.invalidateVersionCache(pageId);

    return { version };
  }

  async restoreVersion(pageId: string, versionId: string) {
    const version = await this.historyRepo.findVersionById(versionId);

    if (!version) {
      throw new NotFoundException('Version not found');
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

    const page = await this.historyRepo.updatePage(pageId, {
      content: parsedContent !== null ? parsedContent : Prisma.JsonNull,
      title: version.title || undefined,
    });

    await this.invalidateVersionCache(pageId);

    return {
      message: 'Version restored successfully',
      page,
    };
  }

  async deleteVersion(versionId: string) {
    const version = await this.historyRepo.findVersionById(versionId);
    if (!version) {
      throw new NotFoundException('Version not found');
    }

    await this.historyRepo.deleteVersion(versionId);
    await this.invalidateVersionCache(version.pageId);

    return { message: 'Version deleted successfully' };
  }

  async getHistory(pageId: string) {
    const history = await this.historyRepo.findPageVersions(pageId);
    return { history, events: history };
  }
}
