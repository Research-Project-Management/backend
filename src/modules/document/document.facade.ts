import { Injectable } from '@nestjs/common';
import { CoreRepository } from './core/core.repository';
import {
  PageListItem,
  PageWithDetails,
} from './core/types/document-repository.interface';
import { PrismaService } from '@/core/database/prisma.service';

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
}

export const DOCUMENT_FACADE = 'DOCUMENT_FACADE';

@Injectable()
export class DocumentFacade implements IDocumentFacade {
  constructor(
    private readonly coreRepository: CoreRepository,
    private readonly prisma: PrismaService,
  ) {}

  async getPageById(
    pageId: string,
    projectId?: string,
  ): Promise<PageWithDetails | null> {
    const page = await this.coreRepository.findPageById(pageId);
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
    return this.coreRepository.findProjectPages(projectId);
  }

  async getProjectPageTree(projectId: string): Promise<PageListItem[]> {
    return this.coreRepository.findProjectPageTree(projectId);
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
}
