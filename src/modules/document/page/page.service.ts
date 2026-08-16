import { Injectable, NotFoundException } from '@nestjs/common';
import { PageRepository } from './page.repository';
import { CreatePageDto, UpdatePageDto } from './dto/page.dto';
import { PageStatus, Prisma } from '@prisma/client';

export type FormattedPage<
  T extends {
    id: string;
    parentPageId?: string | null;
    mainFileId?: string | null;
  },
> = T & {
  parentPage?: string | null;
  mainFile?: string | null;
};

@Injectable()
export class PageService {
  constructor(private readonly pageRepo: PageRepository) {}

  private formatPage<
    T extends {
      id: string;
      parentPageId?: string | null;
      mainFileId?: string | null;
    },
  >(p: T): FormattedPage<T>;
  private formatPage(p: null | undefined): null;
  private formatPage<
    T extends {
      id: string;
      parentPageId?: string | null;
      mainFileId?: string | null;
    },
  >(p: T | null | undefined): FormattedPage<T> | null;
  private formatPage<
    T extends {
      id: string;
      parentPageId?: string | null;
      mainFileId?: string | null;
    },
  >(p: T | null | undefined): FormattedPage<T> | null {
    if (!p) return null;
    return {
      ...p,
      parentPage: p.parentPageId,
      mainFile: p.mainFileId,
    };
  }

  async getWorkspacePages(workspaceId: string) {
    const pages = await this.pageRepo.findWorkspacePages(workspaceId);
    return { pages: pages.map((p) => this.formatPage(p)) };
  }

  async getProjectPages(projectId: string) {
    const pages = await this.pageRepo.findProjectPages(projectId);
    return { pages: pages.map((p) => this.formatPage(p)) };
  }

  async getPage(pageId: string) {
    const page = await this.pageRepo.findPageById(pageId);

    if (!page || page.deletedAt) {
      throw new NotFoundException('Page not found');
    }

    await this.pageRepo.incrementPageView(pageId);

    return { page: this.formatPage(page) };
  }

  async createPage(
    workspaceId: string,
    projectId: string,
    userId: string,
    dto: CreatePageDto,
  ) {
    const targetWorkspaceId = workspaceId || dto.workspaceId;
    const targetProjectId = projectId || dto.projectId;

    let wsId = targetWorkspaceId;
    if (!wsId && targetProjectId) {
      wsId =
        (await this.pageRepo.findProjectWorkspaceId(targetProjectId)) || '';
    }

    const parentPageId = dto.parentPageId || dto.parentPage || null;

    const page = await this.pageRepo.createPage({
      title: dto.title,
      content: dto.content !== undefined ? dto.content : Prisma.JsonNull,
      status: dto.status || PageStatus.draft,
      workspaceId: wsId || '',
      projectId: targetProjectId || '',
      authorId: userId,
      parentPageId,
    });

    return { page: this.formatPage(page) };
  }

  async updatePage(pageId: string, dto: UpdatePageDto) {
    const parentPageId =
      dto.parentPageId !== undefined
        ? dto.parentPageId
        : dto.parentPage !== undefined
          ? dto.parentPage
          : undefined;

    const page = await this.pageRepo.updatePage(pageId, {
      ...(dto.title !== undefined && { title: dto.title }),
      ...(dto.content !== undefined && {
        content: dto.content,
      }),
      ...(dto.status !== undefined && { status: dto.status }),
      ...(dto.mainFileId !== undefined && { mainFileId: dto.mainFileId }),
      ...(dto.pdfThumbnail !== undefined && {
        pdfThumbnail: dto.pdfThumbnail,
      }),
      ...(parentPageId !== undefined && {
        parentPageId: parentPageId || null,
      }),
    });

    return { page: this.formatPage(page) };
  }

  async deletePage(pageId: string) {
    await this.pageRepo.deletePage(pageId);
    return { message: 'Page moved to trash successfully' };
  }

  async duplicatePage(pageId: string, userId: string) {
    const original = await this.pageRepo.findPageById(pageId);

    if (!original) {
      throw new NotFoundException('Page not found');
    }

    const duplicated = await this.pageRepo.createPage({
      title: `${original.title} (Copy)`,
      content: original.content ?? undefined,
      status: PageStatus.draft,
      workspaceId: original.workspaceId,
      projectId: original.projectId,
      authorId: userId,
      parentPageId: original.parentPageId,
    });

    return { page: this.formatPage(duplicated) };
  }

  async getPageFiles(pageId: string) {
    const files = await this.pageRepo.findChildPages(pageId);
    return { files: files.map((f) => this.formatPage(f)) };
  }

  async createPageFile(
    pageId: string,
    userId: string,
    dto: {
      title: string;
      content?: Prisma.InputJsonValue;
      parentPageId?: string;
    },
  ) {
    const parent = await this.pageRepo.findPageById(pageId);

    if (!parent) {
      throw new NotFoundException('Parent page container not found');
    }

    const parentPageId = dto.parentPageId || pageId;

    const page = await this.pageRepo.createPage({
      title: dto.title,
      content: dto.content !== undefined ? dto.content : Prisma.JsonNull,
      status: PageStatus.draft,
      workspaceId: parent.workspaceId,
      projectId: parent.projectId,
      authorId: userId,
      parentPageId,
    });

    return { file: this.formatPage(page) };
  }

  async getChildPages(pageId: string) {
    const files = await this.pageRepo.findChildPages(pageId);
    return { files: files.map((f) => this.formatPage(f)) };
  }

  async createChildPage(
    parentPageId: string,
    userId: string,
    dto: CreatePageDto,
  ) {
    const parent = await this.pageRepo.findPageById(parentPageId);

    if (!parent) {
      throw new NotFoundException('Parent page container not found');
    }

    const page = await this.pageRepo.createPage({
      title: dto.title,
      content: dto.content !== undefined ? dto.content : Prisma.JsonNull,
      status: PageStatus.draft,
      workspaceId: parent.workspaceId,
      projectId: parent.projectId,
      authorId: userId,
      parentPageId,
    });

    return { file: this.formatPage(page) };
  }

  async setMainFile(pageId: string, mainFileId: string) {
    const page = await this.pageRepo.updatePage(pageId, { mainFileId });
    return { page: this.formatPage(page) };
  }

  async updateThumbnail(pageId: string, pdfThumbnail: string) {
    const page = await this.pageRepo.updatePage(pageId, { pdfThumbnail });
    return { page: this.formatPage(page) };
  }
}
