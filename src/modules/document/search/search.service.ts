import {
  Injectable,
  BadRequestException,
  Optional,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { PageRepository } from '../page/page.repository';
import { YjsDocumentManager } from '../collaboration/yjs-document.manager';
import { CollaborationGateway } from '../collaboration/collaboration.gateway';
import { HistoryService } from '../history/history.service';
import { toContentString, resolveCanonicalProjectId } from '../page/utils/page.utils';
import { VersionEventType } from '@prisma/client';
import {
  SearchDocumentQueryDto,
  BatchReplaceDocumentDto,
  SearchResultResponse,
  BatchReplaceResultResponse,
  FileSearchResult,
  SearchMatchEntry,
} from './dto/search-document.dto';

@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pageRepository: PageRepository,
    @Optional() private readonly yjsManager?: YjsDocumentManager,
    @Optional() private readonly collaborationGateway?: CollaborationGateway,
    @Optional() private readonly historyService?: HistoryService,
  ) {}

  /**
   * Safely constructs and validates RegExp pattern with ReDoS guards.
   */
  public buildRegex(
    query: string,
    caseSensitive = false,
    wholeWord = false,
    useRegex = false,
  ): RegExp {
    let pattern = query;
    if (!useRegex) {
      pattern = pattern.replace(/[.*+?^$\{\}()|[\]\\]/g, '\\$&');
    }
    if (wholeWord) {
      pattern = `\\b(?:${pattern})\\b`;
    }
    const flags = caseSensitive ? 'g' : 'gi';
    try {
      return new RegExp(pattern, flags);
    } catch (err: any) {
      throw new BadRequestException(
        `Invalid regular expression: ${err?.message || err}`,
      );
    }
  }

  /**
   * Overleaf-parity project-wide text search.
   * Reads from active in-memory Yjs sessions when files are open in collaborative editing,
   * otherwise falls back to database page content.
   */
  async searchProjectDocuments(
    projectIdOrPageId: string,
    dto: SearchDocumentQueryDto,
  ): Promise<SearchResultResponse> {
    const {
      query,
      caseSensitive = false,
      wholeWord = false,
      useRegex = false,
      fileIds,
      maxResults = 500,
    } = dto;

    if (!query || query.trim() === '') {
      return {
        query: '',
        totalFiles: 0,
        totalMatches: 0,
        results: [],
        truncated: false,
      };
    }

    if (query.length > 500) {
      throw new BadRequestException(
        'Search query exceeds maximum length of 500 characters',
      );
    }

    const regex = this.buildRegex(query, caseSensitive, wholeWord, useRegex);
    const canonicalProjectId = await resolveCanonicalProjectId(
      this.prisma,
      projectIdOrPageId,
    );

    const pages = await this.prisma.page.findMany({
      where: {
        ...(canonicalProjectId
          ? { projectId: canonicalProjectId }
          : {
              OR: [
                { id: projectIdOrPageId },
                { parentPageId: projectIdOrPageId },
                { projectId: projectIdOrPageId },
              ],
            }),
        deletedAt: null,
        ...(fileIds && fileIds.length > 0 ? { id: { in: fileIds } } : {}),
      },
      select: {
        id: true,
        title: true,
        content: true,
        mainFileId: true,
      },
      orderBy: [{ rank: 'asc' }, { updatedAt: 'desc' }],
    });

    const results: FileSearchResult[] = [];
    let totalMatches = 0;
    let truncated = false;

    for (const page of pages) {
      if (totalMatches >= maxResults) {
        truncated = true;
        break;
      }

      // 1. Priority: live active Yjs session in memory > DB content
      let text = '';
      if (this.yjsManager?.hasActiveSession(page.id)) {
        text = this.yjsManager.getText(page.id);
      } else {
        text = toContentString(page.content);
      }

      if (!text) continue;

      const lines = text.split('\n');
      const fileMatches: SearchMatchEntry[] = [];

      for (let i = 0; i < lines.length; i++) {
        if (totalMatches >= maxResults) {
          truncated = true;
          break;
        }

        const lineText = lines[i];
        regex.lastIndex = 0;
        let m: RegExpExecArray | null;

        while ((m = regex.exec(lineText)) !== null) {
          fileMatches.push({
            line: i + 1,
            text: lineText,
            matchStart: m.index,
            matchEnd: m.index + m[0].length,
            snippet: lineText.trim(),
          });
          totalMatches++;

          if (m[0].length === 0) {
            regex.lastIndex++;
          }

          if (totalMatches >= maxResults) {
            truncated = true;
            break;
          }
        }
      }

      if (fileMatches.length > 0) {
        results.push({
          fileId: page.id,
          fileName: page.title,
          isMainFile: !!page.mainFileId,
          totalMatches: fileMatches.length,
          matches: fileMatches,
        });
      }
    }

    return {
      query,
      totalFiles: results.length,
      totalMatches,
      results,
      truncated,
    };
  }

  /**
   * Overleaf-parity atomic project-wide batch replace.
   * Atomically mutates text across documents, broadcasts live CRDT updates
   * to active collaborative clients, and records history version checkpoints.
   */
  async batchReplaceProjectDocuments(
    projectIdOrPageId: string,
    userId: string,
    dto: BatchReplaceDocumentDto,
  ): Promise<BatchReplaceResultResponse> {
    const {
      query,
      replaceWith,
      caseSensitive = false,
      wholeWord = false,
      useRegex = false,
      fileIds,
    } = dto;

    if (!query || query.trim() === '') {
      throw new BadRequestException('Search query is required for replacement');
    }

    if (query.length > 500) {
      throw new BadRequestException(
        'Search query exceeds maximum length of 500 characters',
      );
    }

    const regex = this.buildRegex(query, caseSensitive, wholeWord, useRegex);
    const canonicalProjectId = await resolveCanonicalProjectId(
      this.prisma,
      projectIdOrPageId,
    );

    const pages = await this.prisma.page.findMany({
      where: {
        ...(canonicalProjectId
          ? { projectId: canonicalProjectId }
          : {
              OR: [
                { id: projectIdOrPageId },
                { parentPageId: projectIdOrPageId },
                { projectId: projectIdOrPageId },
              ],
            }),
        deletedAt: null,
        ...(fileIds && fileIds.length > 0 ? { id: { in: fileIds } } : {}),
      },
      select: {
        id: true,
        title: true,
        content: true,
        projectId: true,
      },
    });

    let totalFilesAffected = 0;
    let totalOccurrencesReplaced = 0;
    const affectedFileIds: string[] = [];

    for (const page of pages) {
      let currentText = '';
      const hasActiveYjs = this.yjsManager?.hasActiveSession(page.id);

      if (hasActiveYjs) {
        currentText = this.yjsManager!.getText(page.id);
      } else {
        currentText = toContentString(page.content);
      }

      if (!currentText) continue;

      regex.lastIndex = 0;
      const matches = currentText.match(regex);
      if (!matches || matches.length === 0) continue;

      const occurrences = matches.length;
      regex.lastIndex = 0;
      const newText = currentText.replace(regex, replaceWith);

      if (newText === currentText) continue;

      totalFilesAffected++;
      totalOccurrencesReplaced += occurrences;
      affectedFileIds.push(page.id);

      if (hasActiveYjs && this.yjsManager) {
        // Broadcast through Yjs in memory
        const update = await this.yjsManager.replaceText(
          page.id,
          newText,
          userId,
        );
        if (update && this.collaborationGateway?.server) {
          this.collaborationGateway.server
            .to(`doc:${page.id}`)
            .emit('yjs:update', {
              pageId: page.id,
              update: Buffer.from(update),
            });
        }
      } else {
        // Direct database update
        await this.prisma.page.update({
          where: { id: page.id },
          data: { content: newText },
        });
      }

      // Record automated version checkpoint
      if (this.historyService) {
        try {
          await this.historyService.createVersion(page.id, userId, {
            label: `Batch replace: "${query.slice(0, 30)}" -> "${replaceWith.slice(0, 30)}"`,
            content: newText,
            eventType: VersionEventType.manual_save,
            projectPageId: page.projectId,
          });
        } catch (err: any) {
          this.logger.warn(
            `Failed to record history version for replace on page ${page.id}: ${err?.message || err}`,
          );
        }
      }
    }

    return {
      query,
      replaceWith,
      totalFilesAffected,
      totalOccurrencesReplaced,
      affectedFileIds,
    };
  }
}
