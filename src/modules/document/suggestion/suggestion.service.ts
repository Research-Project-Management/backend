import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
  Optional,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '@/core/database/prisma.service';
import {
  SuggestionRepository,
  SuggestionWithAuthor,
} from './suggestion.repository';
import { CreateSuggestionDto } from './dto/suggestion.dto';
import { SuggestionStatus } from '@prisma/client';
import { CoreService } from '../core/core.service';
import { RedisCacheService } from '@/core/cache/redis.service';
import { DOCUMENT_REDIS_KEYS } from '../core/constants/redis-keys.constant';

function applyReplacementToContent(
  contentStr: string,
  suggestion: {
    type: string;
    originalText: string;
    suggestedText: string;
    fromLine: number;
    toLine: number;
  },
): string {
  const lines = contentStr.split('\n');
  const startIdx = Math.max(0, suggestion.fromLine - 1);
  const endIdx = Math.min(lines.length - 1, suggestion.toLine - 1);

  if (startIdx > lines.length - 1) {
    return contentStr;
  }

  // Extract target text in line range
  const targetSlice = lines.slice(startIdx, endIdx + 1).join('\n');

  if (suggestion.type === 'delete') {
    if (
      suggestion.originalText &&
      targetSlice.includes(suggestion.originalText)
    ) {
      const replaced = targetSlice.replace(suggestion.originalText, '');
      lines.splice(startIdx, endIdx - startIdx + 1, ...replaced.split('\n'));
    } else {
      lines.splice(startIdx, endIdx - startIdx + 1);
    }
  } else if (suggestion.type === 'insert') {
    lines.splice(startIdx, 0, ...suggestion.suggestedText.split('\n'));
  } else {
    // replace
    if (
      suggestion.originalText &&
      targetSlice.includes(suggestion.originalText)
    ) {
      const replaced = targetSlice.replace(
        suggestion.originalText,
        suggestion.suggestedText,
      );
      lines.splice(startIdx, endIdx - startIdx + 1, ...replaced.split('\n'));
    } else {
      lines.splice(
        startIdx,
        endIdx - startIdx + 1,
        ...suggestion.suggestedText.split('\n'),
      );
    }
  }

  return lines.join('\n');
}

@Injectable()
export class SuggestionService {
  private readonly logger = new Logger(SuggestionService.name);

  constructor(
    private readonly suggestionRepo: SuggestionRepository,
    private readonly coreService: CoreService,
    private readonly prisma: PrismaService,
    @Optional() private readonly eventEmitter?: EventEmitter2,
    @Optional() private readonly cache?: RedisCacheService,
  ) {}

  private async invalidateCache(pageId: string, projectId?: string | null) {
    if (!this.cache) return;
    const tasks = [this.cache.del(DOCUMENT_REDIS_KEYS.page(pageId))];
    if (projectId) {
      tasks.push(this.cache.del(DOCUMENT_REDIS_KEYS.projectTree(projectId)));
    }
    await Promise.all(tasks);
  }

  async createSuggestion(
    pageId: string,
    userId: string,
    dto: CreateSuggestionDto,
  ): Promise<SuggestionWithAuthor> {
    const page = await this.coreService.findPageById(pageId);
    if (!page) {
      throw new NotFoundException(`Page ${pageId} not found`);
    }

    const hasAccess = await this.coreService.checkUserAccess(pageId, userId);
    if (!hasAccess) {
      throw new ForbiddenException(
        'You do not have permission to propose suggestions on this document',
      );
    }

    const suggestion = await this.suggestionRepo.create({
      page: { connect: { id: pageId } },
      projectPageId: page.parentPageId || null,
      author: { connect: { id: userId } },
      type: dto.type,
      originalText: dto.originalText || '',
      suggestedText: dto.suggestedText || '',
      fromLine: dto.fromLine,
      fromColumn: dto.fromColumn ?? 1,
      toLine: dto.toLine,
      toColumn: dto.toColumn ?? 1,
      description: dto.description || '',
      status: SuggestionStatus.pending,
    });

    this.eventEmitter?.emit('document.collaboration.event', {
      pageId,
      type: 'suggestion-created',
      suggestion,
      timestamp: Date.now(),
    });

    return suggestion;
  }

  async getSuggestions(
    pageId: string,
    userIdOrStatus?: string | SuggestionStatus,
    maybeStatus?: SuggestionStatus,
  ): Promise<SuggestionWithAuthor[]> {
    let userId: string | undefined;
    let status: SuggestionStatus | undefined;

    if (
      userIdOrStatus === SuggestionStatus.pending ||
      userIdOrStatus === SuggestionStatus.accepted ||
      userIdOrStatus === SuggestionStatus.rejected
    ) {
      status = userIdOrStatus;
    } else {
      userId = userIdOrStatus;
      status = maybeStatus;
    }

    if (userId) {
      const hasAccess = await this.coreService.checkUserAccess(pageId, userId);
      if (!hasAccess) {
        throw new ForbiddenException(
          'You do not have permission to view suggestions on this document',
        );
      }
    }
    return this.suggestionRepo.findByPageId(pageId, status);
  }

  async acceptSuggestion(pageId: string, suggestionId: string, userId: string) {
    const page = await this.coreService.findPageById(pageId);
    if (!page) {
      throw new NotFoundException(`Page ${pageId} not found`);
    }

    const hasAccess = await this.coreService.checkUserAccess(pageId, userId);
    if (!hasAccess) {
      throw new ForbiddenException(
        'You do not have permission to modify suggestions on this document',
      );
    }

    const suggestion = await this.suggestionRepo.findById(suggestionId);
    if (!suggestion || suggestion.pageId !== pageId) {
      throw new NotFoundException(
        `Suggestion ${suggestionId} not found for this page`,
      );
    }

    if (suggestion.status !== SuggestionStatus.pending) {
      throw new BadRequestException(
        `Suggestion is already ${suggestion.status}`,
      );
    }

    if (page.isLocked) {
      throw new ForbiddenException(
        'This document is locked against modifications',
      );
    }

    const rawContent = page.content;
    const currentText =
      typeof rawContent === 'string'
        ? rawContent
        : rawContent && typeof rawContent === 'object'
          ? (rawContent as any).source ||
            (rawContent as any).text ||
            JSON.stringify(rawContent)
          : '';

    const newContent = applyReplacementToContent(currentText, suggestion);

    let finalContent: any = newContent;
    if (
      rawContent &&
      typeof rawContent === 'object' &&
      !Array.isArray(rawContent)
    ) {
      if ('source' in (rawContent as any)) {
        finalContent = { ...(rawContent as any), source: newContent };
      } else if ('text' in (rawContent as any)) {
        finalContent = { ...(rawContent as any), text: newContent };
      }
    }

    const [updatedPage, updatedSuggestion] = await this.prisma.$transaction([
      this.prisma.page.update({
        where: { id: pageId },
        data: {
          content: finalContent,
          updatedAt: new Date(),
        },
      }),
      this.prisma.pageSuggestion.update({
        where: { id: suggestionId },
        data: {
          status: SuggestionStatus.accepted,
          resolvedById: userId,
          resolvedAt: new Date(),
        },
        include: {
          author: {
            select: { id: true, name: true, email: true, avatar: true },
          },
        },
      }),
      this.prisma.pageVersion.create({
        data: {
          pageId,
          projectPageId: page.parentPageId || null,
          title: page.title,
          content:
            typeof finalContent === 'string'
              ? finalContent
              : JSON.stringify(finalContent || ''),
          label: `Accepted suggestion by ${suggestion.author?.name || 'collaborator'}: ${suggestion.description || suggestion.type}`,
          savedById: userId,
          eventType: 'collaborative_checkpoint',
        },
      }),
    ]);

    await this.invalidateCache(pageId, page.projectId);

    this.eventEmitter?.emit('document.collaboration.event', {
      pageId,
      type: 'suggestion-accepted',
      suggestion: updatedSuggestion,
      timestamp: Date.now(),
    });

    return {
      ok: true,
      suggestion: updatedSuggestion,
      page: updatedPage,
    };
  }

  async rejectSuggestion(pageId: string, suggestionId: string, userId: string) {
    const hasAccess = await this.coreService.checkUserAccess(pageId, userId);
    if (!hasAccess) {
      throw new ForbiddenException(
        'You do not have permission to resolve suggestions on this document',
      );
    }

    const suggestion = await this.suggestionRepo.findById(suggestionId);
    if (!suggestion || suggestion.pageId !== pageId) {
      throw new NotFoundException(
        `Suggestion ${suggestionId} not found for this page`,
      );
    }

    if (suggestion.status !== SuggestionStatus.pending) {
      throw new BadRequestException(
        `Suggestion is already ${suggestion.status}`,
      );
    }

    const updated = await this.suggestionRepo.update(suggestionId, {
      status: SuggestionStatus.rejected,
      resolvedById: userId,
      resolvedAt: new Date(),
    });

    this.eventEmitter?.emit('document.collaboration.event', {
      pageId,
      type: 'suggestion-rejected',
      suggestion: updated,
      timestamp: Date.now(),
    });

    return {
      ok: true,
      suggestion: updated,
    };
  }

  async acceptAllSuggestions(pageId: string, userId: string) {
    const page = await this.coreService.findPageById(pageId);
    if (!page) {
      throw new NotFoundException(`Page ${pageId} not found`);
    }

    const hasAccess = await this.coreService.checkUserAccess(pageId, userId);
    if (!hasAccess) {
      throw new ForbiddenException(
        'You do not have permission to modify suggestions on this document',
      );
    }

    const pendingList = await this.suggestionRepo.findByPageId(
      pageId,
      SuggestionStatus.pending,
    );

    if (pendingList.length === 0) {
      return { ok: true, acceptedCount: 0 };
    }

    if (page.isLocked) {
      throw new ForbiddenException(
        'This document is locked against modifications',
      );
    }

    // Sort descending by line and column so earlier positions aren't invalidated by earlier edits
    const sorted = [...pendingList].sort(
      (a, b) =>
        b.fromLine - a.fromLine || (b.fromColumn ?? 1) - (a.fromColumn ?? 1),
    );

    let text =
      typeof page.content === 'string'
        ? page.content
        : page.content && typeof page.content === 'object'
          ? (page.content as any).source ||
            (page.content as any).text ||
            JSON.stringify(page.content)
          : '';

    for (const sugg of sorted) {
      text = applyReplacementToContent(text, sugg);
    }

    let finalContent: any = text;
    const rawContent = page.content;
    if (
      rawContent &&
      typeof rawContent === 'object' &&
      !Array.isArray(rawContent)
    ) {
      if ('source' in (rawContent as any)) {
        finalContent = { ...(rawContent as any), source: text };
      } else if ('text' in (rawContent as any)) {
        finalContent = { ...(rawContent as any), text: text };
      }
    }

    const ids = pendingList.map((s) => s.id);

    await this.prisma.$transaction([
      this.prisma.page.update({
        where: { id: pageId },
        data: {
          content: finalContent,
          updatedAt: new Date(),
        },
      }),
      this.prisma.pageSuggestion.updateMany({
        where: { id: { in: ids } },
        data: {
          status: SuggestionStatus.accepted,
          resolvedById: userId,
          resolvedAt: new Date(),
        },
      }),
      this.prisma.pageVersion.create({
        data: {
          pageId,
          projectPageId: page.parentPageId || null,
          title: page.title,
          content:
            typeof finalContent === 'string'
              ? finalContent
              : JSON.stringify(finalContent || ''),
          label: `Accepted all pending suggestions (${ids.length} changes)`,
          savedById: userId,
          eventType: 'collaborative_checkpoint',
        },
      }),
    ]);

    await this.invalidateCache(pageId, page.projectId);

    this.eventEmitter?.emit('document.collaboration.event', {
      pageId,
      type: 'suggestions-accepted-all',
      count: ids.length,
      timestamp: Date.now(),
    });

    return { ok: true, acceptedCount: ids.length };
  }

  async rejectAllSuggestions(pageId: string, userId: string) {
    const hasAccess = await this.coreService.checkUserAccess(pageId, userId);
    if (!hasAccess) {
      throw new ForbiddenException(
        'You do not have permission to resolve suggestions on this document',
      );
    }

    const pendingList = await this.suggestionRepo.findByPageId(
      pageId,
      SuggestionStatus.pending,
    );

    const ids = pendingList.map((s) => s.id);
    if (ids.length === 0) {
      return { ok: true, rejectedCount: 0 };
    }

    await this.suggestionRepo.updateStatusMany(
      ids,
      SuggestionStatus.rejected,
      userId,
    );

    this.eventEmitter?.emit('document.collaboration.event', {
      pageId,
      type: 'suggestions-rejected-all',
      count: ids.length,
      timestamp: Date.now(),
    });

    return { ok: true, rejectedCount: ids.length };
  }
}
