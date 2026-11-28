/**
 * templates/services/gallery.service.ts
 * Gallery Browsing (Virtual Proxy summary vs detail), `Space` + `Role` Access Verification,
 * Metadata Updates, and Space Template Deletion (with `FileBlob` release).
 * Follows the exact same pattern as `library/citation` (`CslRepositoryService`):
 * Space-scoped DB templates merged with immutable in-code `BUILTIN_TEMPLATES`.
 */

import { Inject, Injectable, Optional } from '@nestjs/common';
import { isUuid } from '@/core';
import { FILES_PORT } from '@/modules/files/files.constant';
import { type IFilesPort } from '@/modules/files/types/files.type';
import { AccessService } from '@/modules/project/access';
import {
  filterBuiltinTemplates,
  findBuiltinTemplate,
} from '../domain/catalog.domain';
import {
  TemplateForbiddenError,
  TemplateNotFoundError,
} from '../domain/errors';
import {
  assertCategory,
  canManageTemplate,
  canReadTemplate,
  normalizeTags,
} from '../domain/policy';
import {
  TemplateDetailView,
  TemplateManifest,
  TemplateSummaryView,
} from '../domain/manifest.domain';
import { QueryTemplatesDto, UpdateTemplateDto } from '../dto/template.dto';
import { TemplatesRepository } from '../templates.repository';

@Injectable()
export class GalleryService {
  constructor(
    private readonly repo: TemplatesRepository,
    @Optional() private readonly access?: AccessService,
    @Optional()
    @Inject(FILES_PORT)
    private readonly filesPort?: IFilesPort,
  ) {}

  public async browse(
    userId: string,
    query?: QueryTemplatesDto,
  ): Promise<{ templates: TemplateSummaryView[]; total: number }> {
    let projectSpaceId: string | undefined;
    if (
      query?.spaceId &&
      isUuid(query.spaceId) &&
      query.spaceId.toLowerCase() !== userId.toLowerCase()
    ) {
      const role = await this.getSpaceRole(query.spaceId, userId);
      if (role) projectSpaceId = query.spaceId;
    }

    const limit = query?.limit ?? 50;
    const offset = query?.offset ?? 0;

    // If filtered by explicit Space scope (`personal` | `project`), query Space DB rows only
    if (query?.scope) {
      const { items, total } = await this.repo.findSummaries({
        userId,
        projectSpaceId,
        category: query.category,
        scope: query.scope,
        search: query.search,
        limit,
        offset,
      });
      return {
        templates: items.map((m) => m.toSummary()),
        total,
      };
    }

    // Default (`All`): Space-owned templates first, followed by built-in academic presets
    const [{ items: spaceItems }, builtinItems] = await Promise.all([
      this.repo.findSummaries({
        userId,
        projectSpaceId,
        category: query?.category,
        search: query?.search,
        limit: 200,
        offset: 0,
      }),
      Promise.resolve(
        filterBuiltinTemplates({
          category: query?.category,
          search: query?.search,
        }),
      ),
    ]);

    const combined = [...spaceItems, ...builtinItems];
    return {
      templates: combined
        .slice(offset, offset + limit)
        .map((m) => m.toSummary()),
      total: combined.length,
    };
  }

  public async getDetail(
    identifier: string,
    userId?: string,
    spaceId?: string,
  ): Promise<TemplateDetailView> {
    const manifest = await this.getAuthorizedManifest(
      identifier,
      userId,
      spaceId,
    );
    return manifest.toDetail();
  }

  public async getAuthorizedManifest(
    identifier: string,
    userId?: string,
    spaceId?: string,
  ): Promise<TemplateManifest> {
    const builtin = findBuiltinTemplate(identifier);
    if (builtin) return builtin;

    const allowedSpaces = [userId, spaceId].filter((id): id is string =>
      Boolean(id && isUuid(id)),
    );
    const manifest = await this.repo.findDetail(identifier, allowedSpaces);
    if (!manifest) {
      throw new TemplateNotFoundError(identifier);
    }

    const memberRole =
      manifest.spaceId && userId
        ? await this.getSpaceRole(manifest.spaceId, userId)
        : null;

    if (
      !canReadTemplate({
        spaceId: manifest.spaceId,
        userId,
        memberRole,
      })
    ) {
      throw new TemplateNotFoundError(identifier);
    }

    return manifest;
  }

  public async update(
    id: string,
    userId: string,
    dto: UpdateTemplateDto,
  ): Promise<TemplateDetailView> {
    if (findBuiltinTemplate(id)) {
      throw new TemplateForbiddenError('Built-in templates cannot be modified');
    }

    const existing = await this.repo.findDetail(id, [userId]);
    if (!existing) throw new TemplateNotFoundError(id);

    await this.assertCanManage(existing, userId);

    const updated = TemplateManifest.create({
      id: existing.id,
      slug: existing.slug,
      name: dto.name ?? existing.name,
      category: dto.category ? assertCategory(dto.category) : existing.category,
      description:
        dto.description !== undefined ? dto.description : existing.description,
      compiler: existing.compiler,
      texlive: existing.texlive,
      mainFile: existing.mainFile,
      author: existing.author,
      thumbnail: existing.thumbnail,
      tags: dto.tags ? normalizeTags(dto.tags) : existing.tags,
      files: existing.files,
      spaceId: existing.spaceId,
      spaceType: existing.scope,
      sourcePageId: existing.sourcePageId,
      createdById: existing.createdById,
      createdAt: existing.createdAt,
      updatedAt: new Date(),
    });

    await this.repo.save(updated);
    return updated.toDetail();
  }

  public async remove(id: string, userId: string): Promise<void> {
    if (findBuiltinTemplate(id)) {
      throw new TemplateForbiddenError('Built-in templates cannot be deleted');
    }

    const existing = await this.repo.findDetail(id, [userId]);
    if (!existing) throw new TemplateNotFoundError(id);

    await this.assertCanManage(existing, userId);
    const { deleted, releasedBlobIds } = await this.repo.deleteById(existing.id);
    if (!deleted) throw new TemplateNotFoundError(id);

    if (this.filesPort && releasedBlobIds.length > 0) {
      await Promise.all(
        releasedBlobIds.map((blobId) =>
          Promise.resolve(this.filesPort!.releaseBlob(blobId)).catch(
            () => null,
          ),
        ),
      );
    }
  }

  public async assertCanManage(
    manifest: TemplateManifest,
    userId: string,
  ): Promise<void> {
    const memberRole = manifest.spaceId
      ? await this.getSpaceRole(manifest.spaceId, userId)
      : null;

    if (
      !canManageTemplate({
        spaceId: manifest.spaceId,
        createdById: manifest.createdById,
        userId,
        memberRole,
      })
    ) {
      throw new TemplateForbiddenError();
    }
  }

  public async getSpaceRole(
    spaceId: string,
    userId: string,
  ): Promise<string | null> {
    if (!spaceId || !userId || !isUuid(spaceId) || !isUuid(userId)) {
      return null;
    }
    if (spaceId.toLowerCase() === userId.toLowerCase()) return 'owner';
    if (!this.access) return 'contributor';
    return this.access.getRole(spaceId, userId).catch(() => null);
  }
}
