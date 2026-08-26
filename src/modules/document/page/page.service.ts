import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Optional,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PageRepository } from './page.repository';
import { CreatePageDto, UpdatePageDto } from './dto/page.dto';
import { PageStatus, Prisma, EntityType } from '@prisma/client';
import { DomainActivityEvent } from '@/modules/activity/events/activity.events';
import { RedisCacheService } from '@/core/cache/redis-cache.service';
import { DOCUMENT_REDIS_KEYS } from '../constants/redis-keys.constant';

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
  constructor(
    private readonly pageRepo: PageRepository,
    @Optional() private readonly eventEmitter?: EventEmitter2,
    @Optional() private readonly cache?: RedisCacheService,
  ) {}

  private async invalidatePageCache(projectId: string, pageId?: string) {
    if (!this.cache) return;
    await Promise.all([
      this.cache.del(DOCUMENT_REDIS_KEYS.projectTree(projectId)),
      pageId
        ? this.cache.del(DOCUMENT_REDIS_KEYS.page(pageId))
        : Promise.resolve(),
    ]);
  }

  private async validateNoCircularParent(
    pageId: string,
    targetParentId: string,
  ): Promise<void> {
    if (pageId === targetParentId) {
      throw new BadRequestException('A page cannot be its own parent');
    }

    let currentParentId: string | null = targetParentId;
    const visited = new Set<string>();

    while (currentParentId) {
      if (currentParentId === pageId) {
        throw new BadRequestException(
          'Circular parent page reference detected',
        );
      }
      if (visited.has(currentParentId)) {
        break;
      }
      visited.add(currentParentId);

      const parentPage = await this.pageRepo.findPageById(currentParentId);
      currentParentId = parentPage?.parentPageId || null;
    }
  }

  private formatPage<
    T extends {
      id: string;
      parentPageId?: string | null;
      mainFileId?: string | null;
    },
  >(pageRecord: T | null | undefined): FormattedPage<T> | null {
    if (!pageRecord) return null;
    return {
      ...pageRecord,
      parentPage: pageRecord.parentPageId ?? null,
      mainFile: pageRecord.mainFileId ?? null,
    };
  }

  async getWorkspacePages(workspaceId: string) {
    const pages = await this.pageRepo.findWorkspacePages(workspaceId);
    return { pages: pages.map((pageRecord) => this.formatPage(pageRecord)) };
  }

  async getProjectPages(projectId: string) {
    const pages = await this.pageRepo.findProjectPages(projectId);
    return { pages: pages.map((pageRecord) => this.formatPage(pageRecord)) };
  }

  async getProjectPageTree(projectId: string) {
    const cacheKey = DOCUMENT_REDIS_KEYS.projectTree(projectId);

    if (this.cache) {
      return this.cache.wrap(
        cacheKey,
        async () => {
          const rawPages = await this.pageRepo.findProjectPageTree(projectId);
          return {
            pages: rawPages.map((pageItem) => this.formatPage(pageItem)),
          };
        },
        3600,
      );
    }

    const rawPages = await this.pageRepo.findProjectPageTree(projectId);
    return { pages: rawPages.map((pageItem) => this.formatPage(pageItem)) };
  }

  async getPage(pageId: string) {
    const cacheKey = DOCUMENT_REDIS_KEYS.page(pageId);
    let page = this.cache ? await this.cache.get<any>(cacheKey) : null;

    if (!page) {
      const rawPage = await this.pageRepo.findPageById(pageId);
      if (!rawPage || rawPage.deletedAt) {
        throw new NotFoundException('Page not found');
      }

      page = this.formatPage(rawPage);

      if (this.cache) {
        await this.cache.set(cacheKey, page, 1800);
      }
    }

    // Increment page view asynchronously without blocking cache read
    void this.pageRepo.incrementPageView(pageId).catch(() => {});

    return { page };
  }

  async createPage(
    workspaceId: string,
    projectId: string,
    userId: string,
    dto: CreatePageDto,
  ) {
    const targetProjectId = projectId || dto.projectId;
    let targetWorkspaceId = workspaceId || dto.workspaceId;

    if (!targetWorkspaceId && targetProjectId) {
      targetWorkspaceId =
        (await this.pageRepo.findProjectWorkspaceId(targetProjectId)) || '';
    }

    if (!targetWorkspaceId) {
      throw new BadRequestException(
        'Workspace context is required to create a page',
      );
    }

    const parentPageId = dto.parentPageId ?? dto.parentPage ?? null;

    const page = await this.pageRepo.createPage({
      title: dto.title,
      slug: dto.slug,
      icon: dto.icon,
      coverImage: dto.coverImage,
      rank: dto.rank ?? 0,
      isLocked: dto.isLocked ?? false,
      isPublished: dto.isPublished ?? false,
      content: dto.content !== undefined ? dto.content : Prisma.JsonNull,
      status: dto.status || PageStatus.draft,
      workspace: { connect: { id: targetWorkspaceId } },
      project: { connect: { id: targetProjectId } },
      author: { connect: { id: userId } },
      ...(parentPageId
        ? { parentPage: { connect: { id: parentPageId } } }
        : {}),
    });

    await this.invalidatePageCache(targetProjectId || '', page.id);

    this.eventEmitter?.emit(
      'page.created',
      new DomainActivityEvent({
        entityType: EntityType.page,
        entityId: page.id,
        verb: 'created',
        actorId: userId,
        workspaceId: page.workspaceId,
        projectId: page.projectId || undefined,
      }),
    );

    return { page: this.formatPage(page) };
  }

  async updatePage(pageId: string, dto: UpdatePageDto) {
    const existing = await this.pageRepo.findPageById(pageId);
    if (!existing || existing.deletedAt) {
      throw new NotFoundException('Page not found');
    }

    const parentPageId = dto.parentPageId ?? dto.parentPage;
    if (parentPageId) {
      await this.validateNoCircularParent(pageId, parentPageId);
    }

    const page = await this.pageRepo.updatePage(pageId, {
      ...(dto.title !== undefined && { title: dto.title }),
      ...(dto.slug !== undefined && { slug: dto.slug }),
      ...(dto.icon !== undefined && { icon: dto.icon }),
      ...(dto.coverImage !== undefined && { coverImage: dto.coverImage }),
      ...(dto.rank !== undefined && { rank: dto.rank }),
      ...(dto.isLocked !== undefined && { isLocked: dto.isLocked }),
      ...(dto.isPublished !== undefined && { isPublished: dto.isPublished }),
      ...(dto.content !== undefined && { content: dto.content }),
      ...(dto.status !== undefined && { status: dto.status }),
      ...(dto.mainFileId !== undefined && {
        mainFile: dto.mainFileId
          ? { connect: { id: dto.mainFileId } }
          : { disconnect: true },
      }),
      ...(dto.pdfThumbnail !== undefined && { pdfThumbnail: dto.pdfThumbnail }),
      ...(parentPageId !== undefined && {
        parentPage: parentPageId
          ? { connect: { id: parentPageId } }
          : { disconnect: true },
      }),
    });

    await this.invalidatePageCache(existing.projectId, pageId);

    this.eventEmitter?.emit(
      'page.updated',
      new DomainActivityEvent({
        entityType: EntityType.page,
        entityId: page.id,
        verb: 'updated',
        actorId: '',
        workspaceId: page.workspaceId,
        projectId: page.projectId || undefined,
      }),
    );

    return { page: this.formatPage(page) };
  }

  async deletePage(pageId: string) {
    const page = await this.pageRepo.findPageById(pageId);
    if (!page) {
      throw new NotFoundException('Page not found');
    }

    await this.pageRepo.softDeletePage(pageId);
    await this.invalidatePageCache(page.projectId, pageId);

    this.eventEmitter?.emit(
      'page.deleted',
      new DomainActivityEvent({
        entityType: EntityType.page,
        entityId: page.id,
        verb: 'deleted',
        actorId: '',
        workspaceId: page.workspaceId,
        projectId: page.projectId || undefined,
      }),
    );

    return { message: 'Page deleted successfully' };
  }

  async restorePage(pageId: string) {
    const restored = await this.pageRepo.restorePage(pageId);
    await this.invalidatePageCache(restored.projectId, pageId);
    return {
      message: 'Page restored successfully',
      page: this.formatPage(restored),
    };
  }

  async duplicatePage(pageId: string, userId: string) {
    const source = await this.pageRepo.findPageById(pageId);
    if (!source) {
      throw new NotFoundException('Page not found');
    }

    const duplicated = await this.pageRepo.createPage({
      title: `${source.title} (Copy)`,
      slug: source.slug ? `${source.slug}-copy` : undefined,
      icon: source.icon,
      coverImage: source.coverImage,
      rank: source.rank + 1,
      content: source.content !== null ? source.content : Prisma.JsonNull,
      status: PageStatus.draft,
      workspace: { connect: { id: source.workspaceId } },
      project: { connect: { id: source.projectId } },
      author: { connect: { id: userId } },
      ...(source.parentPageId
        ? { parentPage: { connect: { id: source.parentPageId } } }
        : {}),
    });

    await this.invalidatePageCache(source.projectId, duplicated.id);

    return { page: this.formatPage(duplicated) };
  }

  async getPageFiles(pageId: string) {
    const page = await this.pageRepo.findPageById(pageId);
    if (!page) {
      throw new NotFoundException('Page not found');
    }
    const files = await this.pageRepo.findChildPages(pageId);
    return { files: files.map((f) => this.formatPage(f)) };
  }

  async createPageFile(
    pageId: string,
    userId: string,
    dto: { title: string; content?: any; parentPageId?: string },
  ) {
    const parent = await this.pageRepo.findPageById(pageId);
    if (!parent) {
      throw new NotFoundException('Parent page not found');
    }

    const created = await this.pageRepo.createPage({
      title: dto.title,
      content: dto.content !== undefined ? dto.content : Prisma.JsonNull,
      status: PageStatus.draft,
      workspace: { connect: { id: parent.workspaceId } },
      project: { connect: { id: parent.projectId } },
      author: { connect: { id: userId } },
      parentPage: { connect: { id: pageId } },
    });

    await this.invalidatePageCache(parent.projectId, created.id);

    return { file: this.formatPage(created) };
  }

  async setMainFile(pageId: string, mainFileId: string) {
    const page = await this.pageRepo.updatePage(pageId, {
      mainFile: { connect: { id: mainFileId } },
    });
    await this.invalidatePageCache(page.projectId, pageId);
    return { page: this.formatPage(page) };
  }

  async updateThumbnail(pageId: string, pdfThumbnail: string) {
    const page = await this.pageRepo.updatePage(pageId, {
      pdfThumbnail,
    });
    await this.invalidatePageCache(page.projectId, pageId);
    return { page: this.formatPage(page) };
  }
}
