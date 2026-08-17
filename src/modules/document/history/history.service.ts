import { Injectable, NotFoundException } from '@nestjs/common';
import { HistoryRepository } from './history.repository';
import { CreateVersionDto } from './dto/history.dto';
import { VersionEventType, Prisma } from '@prisma/client';
import { tryCatchSync } from '@/core/utils/error.util';

@Injectable()
export class HistoryService {
  constructor(private readonly historyRepo: HistoryRepository) {}

  async getVersions(pageId: string) {
    const versions = await this.historyRepo.findPageVersions(pageId);
    return { versions };
  }

  async createVersion(pageId: string, userId: string, dto: CreateVersionDto) {
    const page = await this.historyRepo.findPageById(pageId);

    if (!page) {
      throw new NotFoundException('Page not found');
    }

    const version = await this.historyRepo.createVersion({
      pageId,
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

    return {
      message: 'Version restored successfully',
      page,
    };
  }

  async deleteVersion(versionId: string) {
    await this.historyRepo.deleteVersion(versionId);
    return { message: 'Version deleted successfully' };
  }

  async getHistory(pageId: string) {
    const history = await this.historyRepo.findPageVersions(pageId);
    return { history, events: history };
  }
}
