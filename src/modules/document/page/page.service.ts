import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Optional,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PageRepository } from './page.repository';
import { CreatePageDto, UpdatePageDto } from './dto/page.dto';
import { PageStatus, Prisma, EntityType } from '@prisma/client';
import { DomainActivityEvent } from '@/modules/activity/events/activity.events';
import { RedisCacheService } from '@/core/cache/redis-cache.service';
import { DOCUMENT_REDIS_KEYS } from '../constants/redis-keys.constant';
import { PrismaService } from '@/core/database/prisma.service';

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
    private readonly prisma: PrismaService,
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

    // Lean traversal — only id + parentPageId fetched per hop (no content bloat)
    const chain = await this.pageRepo.findPageAncestorChain(targetParentId);
    const chainIds = new Set(chain.map((p) => p.id));

    if (chainIds.has(pageId)) {
      throw new BadRequestException('Circular parent page reference detected');
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

      // Increment page view asynchronously ONLY on cache miss to eliminate DB write amplification
      void Promise.resolve(this.pageRepo.incrementPageView(pageId)).catch(
        () => {},
      );
    }

    return { page };
  }

  async createPage(
    workspaceId: string,
    projectId: string,
    userId: string,
    dto: CreatePageDto,
  ) {
    const resolvedProjectId = projectId || dto.projectId;
    let resolvedWorkspaceId = workspaceId || dto.workspaceId;

    if (!resolvedProjectId) {
      throw new BadRequestException(
        'Project context is required to create a page',
      );
    }

    const project = await this.prisma.project.findFirst({
      where: { id: resolvedProjectId, deletedAt: null },
    });
    if (!project) {
      throw new NotFoundException('Project not found');
    }

    if (resolvedWorkspaceId && project.workspaceId !== resolvedWorkspaceId) {
      throw new BadRequestException(
        'Project does not belong to the specified workspace',
      );
    }
    resolvedWorkspaceId = project.workspaceId;

    const wsMember = await this.prisma.workspaceMember.findFirst({
      where: { workspaceId: resolvedWorkspaceId, userId },
    });
    if (!wsMember) {
      throw new ForbiddenException('User is not a member of this workspace');
    }

    if (wsMember.role !== 'owner' && wsMember.role !== 'admin') {
      const projMember = await this.prisma.projectMember.findUnique({
        where: { projectId_userId: { projectId: resolvedProjectId, userId } },
      });
      if (
        !projMember ||
        (projMember.role !== 'admin' && projMember.role !== 'contributor')
      ) {
        throw new ForbiddenException(
          'You need contributor or admin role in the project to create pages',
        );
      }
    }

    const parentPageId = dto.parentPageId ?? dto.parentPage ?? null;
    if (parentPageId) {
      const parent = await this.pageRepo.findPageById(parentPageId);
      if (!parent || parent.deletedAt) {
        throw new NotFoundException('Parent page not found');
      }
      if (parent.projectId !== resolvedProjectId) {
        throw new BadRequestException(
          'Parent page belongs to a different project',
        );
      }
    }

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
      workspace: { connect: { id: resolvedWorkspaceId } },
      project: { connect: { id: resolvedProjectId } },
      author: { connect: { id: userId } },
      ...(parentPageId
        ? { parentPage: { connect: { id: parentPageId } } }
        : {}),
    });

    await this.invalidatePageCache(resolvedProjectId || '', page.id);

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
      const parent = await this.pageRepo.findPageById(parentPageId);
      if (!parent || parent.deletedAt) {
        throw new NotFoundException('Parent page not found');
      }
      if (parent.projectId !== existing.projectId) {
        throw new BadRequestException(
          'Parent page belongs to a different project',
        );
      }
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

  async findPageWithVersions(pageId: string) {
    return this.pageRepo.findPageWithVersions(pageId);
  }

  async findPageById(pageId: string) {
    return this.pageRepo.findPageById(pageId);
  }
}
