import { Injectable, Optional, BadRequestException } from '@nestjs/common';
import { PageRepository } from './page/page.repository';
import {
  PageListItem,
  PageWithDetails,
} from './page/types/page-repository.interface';
import { PrismaService } from '@/core/database/prisma.service';
import { PageService } from './page/page.service';
import { CompilerService } from './compiler/compiler.service';
import { ExportService, ExportFileResult } from './export/export.service';
import { HistoryService } from './history/history.service';
import { SearchService } from './search/search.service';
import {
  SearchDocumentQueryDto,
  BatchReplaceDocumentDto,
  SearchResultResponse,
  BatchReplaceResultResponse,
} from './search/dto/search-document.dto';
import { CreatePageDto } from './page/dto/page.dto';
import { CompileDocumentDto } from './compiler/dto/compiler.dto';
import { ExportDocumentDto } from './export/dto/export.dto';
import { CommentStatus, SuggestionStatus } from '@prisma/client';

export interface DocumentSummary {
  id: string;
  title: string;
  slug: string | null;
  projectId: string;
  authorId: string;
  parentPageId: string | null;
  mainFileId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DocumentReviewStats {
  pageId: string;
  openComments: number;
  resolvedComments: number;
  pendingSuggestions: number;
  acceptedSuggestions: number;
  totalItems: number;
}

export interface IDocumentFacade {
  getPageById(
    pageId: string,
    projectId?: string,
  ): Promise<PageWithDetails | null>;
  getPageContent(pageId: string): Promise<string | null>;
  getPageMetadata(pageId: string): Promise<{
    id: string;
    title: string;
    projectId: string;
    isLocked: boolean;
  } | null>;
  getProjectPages(projectId: string): Promise<PageListItem[]>;
  getProjectPageTree(projectId: string): Promise<PageListItem[]>;
  countProjectPages(projectId: string): Promise<number>;
  searchPages(projectId: string, query: string): Promise<DocumentSummary[]>;
  createPage(
    projectId: string,
    authorId: string,
    dto: CreatePageDto,
  ): Promise<any>;
  compilePage(
    pageId: string,
    userId: string,
    dto?: CompileDocumentDto,
  ): Promise<any>;
  exportPage(
    pageId: string,
    userId: string,
    dto: ExportDocumentDto,
  ): Promise<ExportFileResult>;
  getRecentVersions(pageId: string, limit?: number): Promise<any>;
  getReviewStats(pageId: string): Promise<DocumentReviewStats>;
  searchDocuments(
    projectId: string,
    dto: SearchDocumentQueryDto,
  ): Promise<SearchResultResponse>;
  batchReplaceDocuments(
    projectId: string,
    userId: string,
    dto: BatchReplaceDocumentDto,
  ): Promise<BatchReplaceResultResponse>;
}

export const DOCUMENT_FACADE = 'DOCUMENT_FACADE';

@Injectable()
export class DocumentFacade implements IDocumentFacade {
  constructor(
    private readonly pageRepository: PageRepository,
    private readonly prisma: PrismaService,
    @Optional() private readonly pageService?: PageService,
    @Optional() private readonly compilerService?: CompilerService,
    @Optional() private readonly exportService?: ExportService,
    @Optional() private readonly historyService?: HistoryService,
    @Optional() private readonly searchService?: SearchService,
  ) {}

  async getPageById(
    pageId: string,
    projectId?: string,
  ): Promise<PageWithDetails | null> {
    const page = await this.pageRepository.findPageById(pageId);
    if (!page) return null;
    if (projectId && page.projectId !== projectId) return null;
    return page;
  }

  async getPageContent(pageId: string): Promise<string | null> {
    const page = await this.prisma.page.findFirst({
      where: { id: pageId, deletedAt: null },
      select: { content: true },
    });
    if (!page || page.content === null) return null;
    if (typeof page.content === 'string') return page.content;
    return JSON.stringify(page.content);
  }

  async getPageMetadata(pageId: string): Promise<{
    id: string;
    title: string;
    projectId: string;
    isLocked: boolean;
  } | null> {
    return this.prisma.page.findFirst({
      where: { id: pageId, deletedAt: null },
      select: {
        id: true,
        title: true,
        projectId: true,
        isLocked: true,
      },
    });
  }

  async getProjectPages(projectId: string): Promise<PageListItem[]> {
    return this.pageRepository.findProjectPages(projectId);
  }

  async getProjectPageTree(projectId: string): Promise<PageListItem[]> {
    return this.pageRepository.findProjectPageTree(projectId);
  }

  async countProjectPages(projectId: string): Promise<number> {
    return this.prisma.page.count({
      where: {
        projectId,
        deletedAt: null,
      },
    });
  }

  async searchPages(
    projectId: string,
    query: string,
  ): Promise<DocumentSummary[]> {
    const pages = await this.prisma.page.findMany({
      where: {
        projectId,
        deletedAt: null,
        title: { contains: query, mode: 'insensitive' },
      },
      select: {
        id: true,
        title: true,
        slug: true,
        projectId: true,
        authorId: true,
        parentPageId: true,
        mainFileId: true,
        createdAt: true,
        updatedAt: true,
      },
      take: 20,
    });

    return pages;
  }

  async createPage(
    projectId: string,
    authorId: string,
    dto: CreatePageDto,
  ): Promise<any> {
    if (this.pageService) {
      return this.pageService.createPage(projectId, authorId, dto);
    }
    return this.pageRepository.createPage({
      ...dto,
      projectId,
      authorId,
    });
  }

  async compilePage(
    pageId: string,
    userId: string,
    dto?: CompileDocumentDto,
  ): Promise<any> {
    if (!this.compilerService) {
      throw new BadRequestException(
        'CompilerService is not available in DocumentFacade',
      );
    }
    return this.compilerService.buildDocument(pageId, dto);
  }

  async exportPage(
    pageId: string,
    userId: string,
    dto: ExportDocumentDto,
  ): Promise<ExportFileResult> {
    if (!this.exportService) {
      throw new BadRequestException(
        'ExportService is not available in DocumentFacade',
      );
    }
    return this.exportService.exportDocument(pageId, userId, dto);
  }

  async getRecentVersions(pageId: string, limit: number = 10): Promise<any> {
    if (this.historyService) {
      return this.historyService.getVersions(pageId, { limit });
    }
    const versions = await this.prisma.pageVersion.findMany({
      where: { pageId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return { versions, nextCursor: null };
  }

  async getReviewStats(pageId: string): Promise<DocumentReviewStats> {
    const [
      openComments,
      resolvedComments,
      pendingSuggestions,
      acceptedSuggestions,
    ] = await Promise.all([
      this.prisma.pageComment.count({
        where: { pageId, status: CommentStatus.open, deletedAt: null },
      }),
      this.prisma.pageComment.count({
        where: { pageId, status: CommentStatus.resolved, deletedAt: null },
      }),
      this.prisma.pageSuggestion.count({
        where: { pageId, status: SuggestionStatus.pending, deletedAt: null },
      }),
      this.prisma.pageSuggestion.count({
        where: { pageId, status: SuggestionStatus.accepted, deletedAt: null },
      }),
    ]);

    return {
      pageId,
      openComments,
      resolvedComments,
      pendingSuggestions,
      acceptedSuggestions,
      totalItems:
        openComments +
        resolvedComments +
        pendingSuggestions +
        acceptedSuggestions,
    };
  }

  async searchDocuments(
    projectId: string,
    dto: SearchDocumentQueryDto,
  ): Promise<SearchResultResponse> {
    if (!this.searchService) {
      throw new BadRequestException(
        'SearchService is not available in DocumentFacade',
      );
    }
    return this.searchService.searchProjectDocuments(projectId, dto);
  }

  async batchReplaceDocuments(
    projectId: string,
    userId: string,
    dto: BatchReplaceDocumentDto,
  ): Promise<BatchReplaceResultResponse> {
    if (!this.searchService) {
      throw new BadRequestException(
        'SearchService is not available in DocumentFacade',
      );
    }
    return this.searchService.batchReplaceProjectDocuments(
      projectId,
      userId,
      dto,
    );
  }
}
