import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
  Optional,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '@/core/database/prisma.service';
import { SuggestionRepository, SuggestionWithAuthor } from './suggestion.repository';
import { CreateSuggestionDto } from './dto/suggestion.dto';
import { SuggestionStatus } from '@prisma/client';
import { CoreService } from '../core/core.service';

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
    if (suggestion.originalText && targetSlice.includes(suggestion.originalText)) {
      const replaced = targetSlice.replace(suggestion.originalText, '');
      lines.splice(startIdx, endIdx - startIdx + 1, ...replaced.split('\n'));
    } else {
      lines.splice(startIdx, endIdx - startIdx + 1);
    }
  } else if (suggestion.type === 'insert') {
    lines.splice(startIdx, 0, suggestion.suggestedText);
  } else {
    // replace
    if (suggestion.originalText && targetSlice.includes(suggestion.originalText)) {
      const replaced = targetSlice.replace(suggestion.originalText, suggestion.suggestedText);
      lines.splice(startIdx, endIdx - startIdx + 1, ...replaced.split('\n'));
    } else {
      lines.splice(startIdx, endIdx - startIdx + 1, suggestion.suggestedText);
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
  ) {}

  async createSuggestion(
    pageId: string,
    userId: string,
    dto: CreateSuggestionDto,
  ): Promise<SuggestionWithAuthor> {
    const page = await this.coreService.findPageById(pageId);
    if (!page) {
      throw new NotFoundException(`Page ${pageId} not found`);
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
    status?: SuggestionStatus,
  ): Promise<SuggestionWithAuthor[]> {
    return this.suggestionRepo.findByPageId(pageId, status);
  }

  async acceptSuggestion(
    pageId: string,
    suggestionId: string,
    userId: string,
  ) {
    const suggestion = await this.suggestionRepo.findById(suggestionId);
    if (!suggestion || suggestion.pageId !== pageId) {
      throw new NotFoundException(`Suggestion ${suggestionId} not found for this page`);
    }

    if (suggestion.status !== SuggestionStatus.pending) {
      throw new BadRequestException(`Suggestion is already ${suggestion.status}`);
    }

    const page = await this.coreService.findPageById(pageId);
    if (!page) {
      throw new NotFoundException(`Page ${pageId} not found`);
    }

    const rawContent = page.content;
    const currentText =
      typeof rawContent === 'string'
        ? rawContent
        : rawContent && typeof rawContent === 'object'
          ? (rawContent as any).source || (rawContent as any).text || JSON.stringify(rawContent)
          : '';

    const newContent = applyReplacementToContent(currentText, suggestion);

    const [updatedPage, updatedSuggestion] = await this.prisma.$transaction([
      this.prisma.page.update({
        where: { id: pageId },
        data: {
          content: newContent,
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
    ]);

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

  async rejectSuggestion(
    pageId: string,
    suggestionId: string,
    userId: string,
  ) {
    const suggestion = await this.suggestionRepo.findById(suggestionId);
    if (!suggestion || suggestion.pageId !== pageId) {
      throw new NotFoundException(`Suggestion ${suggestionId} not found for this page`);
    }

    if (suggestion.status !== SuggestionStatus.pending) {
      throw new BadRequestException(`Suggestion is already ${suggestion.status}`);
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
    const pendingList = await this.suggestionRepo.findByPageId(
      pageId,
      SuggestionStatus.pending,
    );

    if (pendingList.length === 0) {
      return { ok: true, acceptedCount: 0 };
    }

    // Sort descending by line so earlier line positions aren't invalidated by earlier edits
    const sorted = [...pendingList].sort((a, b) => b.fromLine - a.fromLine);

    const page = await this.coreService.findPageById(pageId);
    if (!page) {
      throw new NotFoundException(`Page ${pageId} not found`);
    }

    let text =
      typeof page.content === 'string'
        ? page.content
        : page.content && typeof page.content === 'object'
          ? (page.content as any).source || (page.content as any).text || JSON.stringify(page.content)
          : '';

    for (const sugg of sorted) {
      text = applyReplacementToContent(text, sugg);
    }

    const ids = pendingList.map((s) => s.id);

    await this.prisma.$transaction([
      this.prisma.page.update({
        where: { id: pageId },
        data: {
          content: text,
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
    ]);

    this.eventEmitter?.emit('document.collaboration.event', {
      pageId,
      type: 'suggestions-accepted-all',
      count: ids.length,
      timestamp: Date.now(),
    });

    return { ok: true, acceptedCount: ids.length };
  }

  async rejectAllSuggestions(pageId: string, userId: string) {
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
