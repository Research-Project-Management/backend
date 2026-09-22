import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  ConflictException,
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
import { PageService } from '../page/page.service';
import { RedisCacheService } from '@/core/cache/redis.service';
import { DOCUMENT_REDIS_KEYS } from '../page/constants/page-redis-keys.constant';
import { YjsDocumentManager } from '../collaboration/yjs-document.manager';
import { CollaborationGateway } from '../collaboration/collaboration.gateway';
import { NotificationBundlerService } from '../notification/notification-bundler.service';
import { getErrorMessage } from '@/core/utils/error.util';
import { toContentString } from '../page/utils/page.utils';

/**
 * Deep, safe replacement algorithm protecting document integrity against line drift.
 * Pure function: testable in total isolation (Matt Pocock design principle).
 */
export function applyReplacementSafely(
  contentStr: string,
  suggestion: {
    type: string;
    originalText?: string | null;
    suggestedText?: string | null;
    fromLine: number;
    toLine: number;
  },
): string {
  const lines = contentStr.split('\n');
  const startIdx = Math.max(0, suggestion.fromLine - 1);
  const endIdx = Math.min(lines.length - 1, suggestion.toLine - 1);
  const suggestedText = suggestion.suggestedText || '';
  const original = suggestion.originalText || '';

  // 1. Pure insert without original text anchor
  if (suggestion.type === 'insert' && !original) {
    const insertIdx = Math.min(lines.length, startIdx);
    lines.splice(insertIdx, 0, ...suggestedText.split('\n'));
    return lines.join('\n');
  }

  // 2. When originalText is specified (replace or delete)
  if (original) {
    // 2a. Direct match at specified line range
    const targetSlice = lines.slice(startIdx, endIdx + 1).join('\n');
    if (targetSlice.includes(original)) {
      const replacement = suggestion.type === 'delete' ? '' : suggestedText;
      const replacedSlice = targetSlice.replace(original, replacement);
      lines.splice(
        startIdx,
        endIdx - startIdx + 1,
        ...replacedSlice.split('\n'),
      );
      return lines.join('\n');
    }

    // 2b. Line drift compensation: Search within a sliding window (±15 lines) around expected position
    const windowStart = Math.max(0, startIdx - 15);
    const windowEnd = Math.min(lines.length - 1, endIdx + 15);
    const windowSlice = lines.slice(windowStart, windowEnd + 1).join('\n');
    if (windowSlice.includes(original)) {
      const replacement = suggestion.type === 'delete' ? '' : suggestedText;
      const replacedSlice = windowSlice.replace(original, replacement);
      lines.splice(
        windowStart,
        windowEnd - windowStart + 1,
        ...replacedSlice.split('\n'),
      );
      return lines.join('\n');
    }

    // 2c. Full document fallback search
    if (contentStr.includes(original)) {
      const replacement = suggestion.type === 'delete' ? '' : suggestedText;
      return contentStr.replace(original, replacement);
    }

    // 2d. Conflict detection: originalText is missing/modified by another collaborator
    const preview =
      original.length > 35 ? `${original.slice(0, 32)}...` : original;
    throw new ConflictException(
      `Cannot apply suggestion: the original text "${preview}" has been modified or removed by another collaborator.`,
    );
  }

  // 3. Line-based replace/delete without originalText
  if (suggestion.type === 'delete') {
    lines.splice(startIdx, endIdx - startIdx + 1);
  } else {
    lines.splice(startIdx, endIdx - startIdx + 1, ...suggestedText.split('\n'));
  }

  return lines.join('\n');
}

@Injectable()
export class SuggestionService {
  private readonly logger = new Logger(SuggestionService.name);

  constructor(
    private readonly suggestionRepo: SuggestionRepository,
    private readonly pageService: PageService,
    private readonly prisma: PrismaService,
    @Optional() private readonly eventEmitter?: EventEmitter2,
    @Optional() private readonly cache?: RedisCacheService,
    @Optional() private readonly yjsManager?: YjsDocumentManager,
    @Optional() private readonly collaborationGateway?: CollaborationGateway,
    @Optional() private readonly bundlerService?: NotificationBundlerService,
  ) {}

  private async invalidateCache(pageId: string, projectId?: string | null) {
    if (projectId) {
      await this.pageService.invalidatePageCache(projectId, pageId);
    } else if (this.cache) {
      await this.cache.del(DOCUMENT_REDIS_KEYS.page(pageId));
    }
  }

  async createSuggestion(
    pageId: string,
    userId: string,
    dto: CreateSuggestionDto,
  ): Promise<SuggestionWithAuthor> {
    const page = await this.pageService.findPageById(pageId);
    if (!page) {
      throw new NotFoundException(`Page ${pageId} not found`);
    }

    const hasAccess = await this.pageService.checkUserAccess(pageId, userId);
    if (!hasAccess) {
      throw new ForbiddenException(
        'You do not have permission to propose suggestions on this document',
      );
    }

    if (page.isLocked) {
      throw new ForbiddenException(
        'This document is locked against modifications',
      );
    }

    if (dto.fromLine > dto.toLine) {
      throw new BadRequestException(
        'Starting line (fromLine) cannot be greater than ending line (toLine)',
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

    this.collaborationGateway?.broadcastRoomEvent(
      pageId,
      'suggestion:created',
      {
        pageId,
        suggestion,
      },
    );

    this.eventEmitter?.emit('document.collaboration.event', {
      pageId,
      type: 'suggestion-created',
      suggestion,
      timestamp: Date.now(),
    });

    // Overleaf Parity: Enqueue review suggestion event for page author
    if (this.bundlerService && page.authorId && page.authorId !== userId) {
      this.bundlerService
        .enqueueEvent(page.authorId, {
          type: 'suggestion',
          authorId: userId,
          authorName: suggestion.author.name || 'A collaborator',
          projectId: page.projectId || undefined,
          pageId,
          pageTitle: page.title || undefined,
          targetId: suggestion.id,
          contentSnippet: (
            dto.suggestedText ||
            dto.originalText ||
            dto.description ||
            ''
          ).slice(0, 120),
        })
        .catch((err) =>
          this.logger.debug(`Notification bundler error: ${err.message}`),
        );
    }

    return suggestion;
  }

  async getSuggestions(
    pageId: string,
    userIdOrStatus?: string,
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
      const hasAccess = await this.pageService.checkUserAccess(pageId, userId);
      if (!hasAccess) {
        throw new ForbiddenException(
          'You do not have permission to view suggestions on this document',
        );
      }
    }
    return this.suggestionRepo.findByPageId(pageId, status);
  }

  async acceptSuggestion(pageId: string, suggestionId: string, userId: string) {
    const page = await this.pageService.findPageById(pageId);
    if (!page) {
      throw new NotFoundException(`Page ${pageId} not found`);
    }

    const hasAccess = await this.pageService.checkUserAccess(pageId, userId);
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

    // 1. Read live text from in-memory Yjs if active, otherwise fallback to Postgres
    let currentText = '';
    const hasLiveYjs = Boolean(this.yjsManager?.hasActiveSession(pageId));
    if (hasLiveYjs) {
      currentText = this.yjsManager!.getText(pageId);
    } else {
      const rawContent = page.content;
      currentText =
        typeof rawContent === 'string'
          ? rawContent
          : rawContent && typeof rawContent === 'object'
            ? (rawContent as any).source ||
              (rawContent as any).text ||
              JSON.stringify(rawContent)
            : '';
    }

    const newContent = applyReplacementSafely(currentText, suggestion);

    // 2. If Yjs is active, perform atomic replace in Y.Doc and broadcast yjs:update to all clients
    if (hasLiveYjs) {
      const update = await this.yjsManager!.replaceText(
        pageId,
        newContent,
        userId,
      );
      if (update && this.collaborationGateway) {
        this.collaborationGateway.broadcastYjsUpdate(pageId, update);
      }
    }

    let finalContent: any = newContent;
    const rawContent = page.content;
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
            select: {
              id: true,
              email: true,
              profile: {
                select: {
                  name: true,
                  avatar: true,
                },
              },
            },
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

    const formattedSuggestion = {
      ...updatedSuggestion,
      author: {
        id: updatedSuggestion.author.id,
        email: updatedSuggestion.author.email,
        name: updatedSuggestion.author.profile?.name ?? 'User',
        avatar: updatedSuggestion.author.profile?.avatar ?? null,
      },
    };

    // Realtime broadcast to room doc:pageId
    this.collaborationGateway?.broadcastRoomEvent(
      pageId,
      'suggestion:accepted',
      {
        pageId,
        suggestion: formattedSuggestion,
        resolvedBy: userId,
      },
    );

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
    const hasAccess = await this.pageService.checkUserAccess(pageId, userId);
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

    this.collaborationGateway?.broadcastRoomEvent(
      pageId,
      'suggestion:rejected',
      {
        pageId,
        suggestion: updated,
        suggestionId,
        resolvedBy: userId,
      },
    );

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
    const page = await this.pageService.findPageById(pageId);
    if (!page) {
      throw new NotFoundException(`Page ${pageId} not found`);
    }

    const hasAccess = await this.pageService.checkUserAccess(pageId, userId);
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

    const hasLiveYjs = Boolean(this.yjsManager?.hasActiveSession(pageId));
    let text = '';
    if (hasLiveYjs) {
      text = this.yjsManager!.getText(pageId);
    } else {
      text = toContentString(page.content);
    }

    const appliedIds: string[] = [];
    for (const sugg of sorted) {
      try {
        text = applyReplacementSafely(text, sugg);
        appliedIds.push(sugg.id);
      } catch (err) {
        this.logger.warn(
          `Skipping conflicting suggestion ${sugg.id} during accept-all: ${getErrorMessage(err)}`,
        );
      }
    }

    if (appliedIds.length === 0) {
      return { ok: true, acceptedCount: 0 };
    }

    if (hasLiveYjs) {
      const update = await this.yjsManager!.replaceText(pageId, text, userId);
      if (update && this.collaborationGateway) {
        this.collaborationGateway.broadcastYjsUpdate(pageId, update);
      }
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

    const [updatedPage] = await this.prisma.$transaction([
      this.prisma.page.update({
        where: { id: pageId },
        data: {
          content: finalContent,
          updatedAt: new Date(),
        },
      }),
      this.prisma.pageSuggestion.updateMany({
        where: { id: { in: appliedIds } },
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
          label: `Accepted all pending suggestions (${appliedIds.length} changes)`,
          savedById: userId,
          eventType: 'collaborative_checkpoint',
        },
      }),
    ]);

    await this.invalidateCache(pageId, page.projectId);

    this.collaborationGateway?.broadcastRoomEvent(
      pageId,
      'suggestions:accepted-all',
      {
        pageId,
        count: appliedIds.length,
        acceptedIds: appliedIds,
        resolvedBy: userId,
        page: updatedPage,
      },
    );

    this.eventEmitter?.emit('document.collaboration.event', {
      pageId,
      type: 'suggestions-accepted-all',
      count: appliedIds.length,
      page: updatedPage,
      timestamp: Date.now(),
    });

    return { ok: true, acceptedCount: appliedIds.length, page: updatedPage };
  }

  async rejectAllSuggestions(pageId: string, userId: string) {
    const page = await this.pageService.findPageById(pageId);
    if (!page) {
      throw new NotFoundException(`Page ${pageId} not found`);
    }

    const hasAccess = await this.pageService.checkUserAccess(pageId, userId);
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

    await this.invalidateCache(pageId, page.projectId);

    this.collaborationGateway?.broadcastRoomEvent(
      pageId,
      'suggestions:rejected-all',
      {
        pageId,
        count: ids.length,
        rejectedIds: ids,
        resolvedBy: userId,
      },
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
