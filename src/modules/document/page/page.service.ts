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

  async getPage(pageId: string, projectId?: string) {
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

    if (projectId && page.projectId !== projectId) {
      throw new NotFoundException('Page not found in this project');
    }

    return { page };
  }

  async createPage(
    effectiveWorkspaceIdOrProjectId: string,
    projectIdOrUserId: string,
    userIdOrDto: string | CreatePageDto,
    maybeDto?: CreatePageDto,
  ) {
    let projectId: string;
    let userId: string;
    let dto: CreatePageDto;

    if (typeof userIdOrDto === 'object' && userIdOrDto !== null) {
      // Direct projectId scoping: (projectId, userId, dto)
      projectId = effectiveWorkspaceIdOrProjectId;
      userId = projectIdOrUserId;
      dto = userIdOrDto;
    } else {
      // Legacy signature: (workspaceId, projectId, userId, dto)
      projectId = projectIdOrUserId || (maybeDto?.projectId ?? '');
      userId = userIdOrDto as string;
      dto = maybeDto!;
    }

    const resolvedProjectId = projectId || dto.projectId;

    if (!resolvedProjectId) {
      throw new BadRequestException(
        'Project context (projectId) is required to create a page',
      );
    }

    const project = await this.pageRepo.findProjectContext(resolvedProjectId);
    if (!project) {
      throw new NotFoundException('Project not found');
    }

    const resolvedWorkspaceId = project.workspaceId;

    const projMember = await this.pageRepo.findProjectMember(
      project.id,
      userId,
    );
    if (
      !projMember ||
      (projMember.role !== 'admin' && projMember.role !== 'contributor')
    ) {
      const wsMember = await this.pageRepo.findWorkspaceMember(
        resolvedWorkspaceId,
        userId,
      );
      if (!wsMember || (wsMember.role !== 'owner' && wsMember.role !== 'admin')) {
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
      if (parent.projectId !== project.id) {
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
      project: { connect: { id: project.id } },
      author: { connect: { id: userId } },
      ...(parentPageId
        ? { parentPage: { connect: { id: parentPageId } } }
        : {}),
    });

    await this.invalidatePageCache(project.id, page.id);

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

  async updatePage(pageId: string, dto: UpdatePageDto, projectId?: string) {
    const existing = await this.pageRepo.findPageById(pageId);
    if (!existing || existing.deletedAt) {
      throw new NotFoundException('Page not found');
    }

    if (projectId && existing.projectId !== projectId) {
      throw new NotFoundException('Page not found in this project');
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

  async deletePage(pageId: string, projectId?: string) {
    const page = await this.pageRepo.findPageById(pageId);
    if (!page) {
      throw new NotFoundException('Page not found');
    }

    if (projectId && page.projectId !== projectId) {
      throw new NotFoundException('Page not found in this project');
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

  async restorePage(pageId: string, projectId?: string) {
    const page = await this.pageRepo.findPageById(pageId);
    if (page && projectId && page.projectId !== projectId) {
      throw new NotFoundException('Page not found in this project');
    }

    const restored = await this.pageRepo.restorePage(pageId);
    await this.invalidatePageCache(restored.projectId, pageId);
    return {
      message: 'Page restored successfully',
      page: this.formatPage(restored),
    };
  }

  async duplicatePage(pageId: string, userId: string, projectId?: string) {
    const source = await this.pageRepo.findPageById(pageId);
    if (!source) {
      throw new NotFoundException('Page not found');
    }

    if (projectId && source.projectId !== projectId) {
      throw new NotFoundException('Page not found in this project');
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

  async getPageFiles(pageId: string, projectId?: string) {
    const page = await this.pageRepo.findPageById(pageId);
    if (!page) {
      throw new NotFoundException('Page not found');
    }
    if (projectId && page.projectId !== projectId) {
      throw new NotFoundException('Page not found in this project');
    }
    const files = await this.pageRepo.findChildPages(pageId);
    return { files: files.map((f) => this.formatPage(f)) };
  }

  async createPageFile(
    pageId: string,
    userId: string,
    dto: { title: string; content?: any; parentPageId?: string },
    projectId?: string,
  ) {
    const parent = await this.pageRepo.findPageById(pageId);
    if (!parent) {
      throw new NotFoundException('Parent page not found');
    }
    if (projectId && parent.projectId !== projectId) {
      throw new NotFoundException('Page not found in this project');
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

  async setMainFile(pageId: string, mainFileId: string, projectId?: string) {
    const page = await this.pageRepo.findPageById(pageId);
    if (!page) {
      throw new NotFoundException('Page not found');
    }
    if (projectId && page.projectId !== projectId) {
      throw new NotFoundException('Page not found in this project');
    }

    const updated = await this.pageRepo.updatePage(pageId, {
      mainFile: { connect: { id: mainFileId } },
    });
    await this.invalidatePageCache(page.projectId, pageId);
    return { page: this.formatPage(updated) };
  }

  async updateThumbnail(pageId: string, pdfThumbnail: string, projectId?: string) {
    const page = await this.pageRepo.findPageById(pageId);
    if (!page) {
      throw new NotFoundException('Page not found');
    }
    if (projectId && page.projectId !== projectId) {
      throw new NotFoundException('Page not found in this project');
    }

    const updated = await this.pageRepo.updatePage(pageId, {
      pdfThumbnail,
    });
    await this.invalidatePageCache(page.projectId, pageId);
    return { page: this.formatPage(updated) };
  }

  async findPageWithVersions(pageId: string) {
    return this.pageRepo.findPageWithVersions(pageId);
  }

  async findPageById(pageId: string) {
    return this.pageRepo.findPageById(pageId);
  }

  async checkUserAccess(pageId: string, userId: string): Promise<boolean> {
    const page = await this.pageRepo.findPageById(pageId);
    if (!page) return false;

    if (page.workspaceId) {
      const wsMember = await this.pageRepo.findWorkspaceMember(
        page.workspaceId,
        userId,
      );
      if (wsMember) return true;
    }

    if (page.projectId) {
      const projMember = await this.pageRepo.findProjectMember(
        page.projectId,
        userId,
      );
      if (projMember) return true;
    }

    return false;
  }

  async checkProjectAccess(
    projectId: string,
    userId: string,
  ): Promise<boolean> {
    const project = await this.pageRepo.findProjectContext(projectId);
    if (!project) return false;

    if (project.workspaceId) {
      const wsMember = await this.pageRepo.findWorkspaceMember(
        project.workspaceId,
        userId,
      );
      if (wsMember) return true;
    }

    const projMember = await this.pageRepo.findProjectMember(
      project.id,
      userId,
    );
    if (projMember) return true;

    return false;
  }
}
