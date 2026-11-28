/**
 * templates/services/gallery.service.ts
 * Gallery Browsing (Virtual Proxy summary vs detail), Access Verification,
 * Metadata Updates, and Custom Template Deletion.
 */

import { Injectable, Optional } from '@nestjs/common';
import { isUuid } from '@/core';
import { AccessConfigService, AccessService } from '@/modules/project/access';
import {
  TemplateForbiddenError,
  TemplateNotFoundError,
} from '../domain/errors';
import {
  canManageTemplate,
  canReadTemplate,
  assertCategory,
  assertCompiler,
  normalizeTags,
  assertVisibility,
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
    @Optional() private readonly accessConfig?: AccessConfigService,
  ) {}

  public async browse(
    userId: string,
    query?: QueryTemplatesDto,
  ): Promise<{ templates: TemplateSummaryView[]; total: number }> {
    let spaceId = query?.spaceId;
    if (spaceId && !(await this.hasSpaceAccess(spaceId, userId, false))) {
      spaceId = undefined;
    }

    const { items, total } = await this.repo.findSummaries({
      userId,
      spaceId,
      category: query?.category,
      visibility: query?.visibility,
      tag: query?.tag,
      search: query?.search,
      limit: query?.limit ?? 50,
      offset: query?.offset ?? 0,
    });

    return {
      templates: items.map((m) => m.toSummary()),
      total,
    };
  }

  public async getDetail(
    identifier: string,
    userId?: string,
  ): Promise<TemplateDetailView> {
    const manifest = await this.getAuthorizedManifest(identifier, userId);
    return manifest.toDetail();
  }

  public async getAuthorizedManifest(
    identifier: string,
    userId?: string,
  ): Promise<TemplateManifest> {
    const manifest = await this.repo.findDetail(identifier);
    if (!manifest) {
      throw new TemplateNotFoundError(identifier);
    }

    const isOp = userId
      ? (this.accessConfig?.isOperator(userId) ?? false)
      : false;
    const canReadSpace =
      manifest.visibility === 'workspace' && manifest.spaceId && userId
        ? await this.hasSpaceAccess(manifest.spaceId, userId, false)
        : false;

    if (
      !canReadTemplate({
        visibility: manifest.visibility,
        createdById: manifest.createdById,
        userId,
        isOperator: isOp,
        canReadSpace,
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
    const existing = await this.repo.findDetail(id);
    if (!existing) throw new TemplateNotFoundError(id);

    await this.assertCanManage(existing, userId, dto.visibility);

    const updated = TemplateManifest.create({
      id: existing.id,
      slug: existing.slug,
      versionId: existing.versionId,
      name: dto.name ?? existing.name,
      category: dto.category ? assertCategory(dto.category) : existing.category,
      visibility: dto.visibility
        ? assertVisibility(dto.visibility)
        : existing.visibility,
      description:
        dto.description !== undefined ? dto.description : existing.description,
      compiler: dto.compiler ? assertCompiler(dto.compiler) : existing.compiler,
      texLiveVersion: existing.texLiveVersion,
      mainFile: dto.mainFile ?? existing.mainFile,
      author: existing.author,
      license: dto.license !== undefined ? dto.license : existing.license,
      sourceUrl:
        dto.sourceUrl !== undefined ? dto.sourceUrl : existing.sourceUrl,
      thumbnailUrl: existing.thumbnailUrl,
      downloadCount: existing.downloadCount,
      tags: dto.tags ? normalizeTags(dto.tags) : existing.tags,
      files: existing.files,
      spaceId: existing.spaceId,
      createdById: existing.createdById,
      createdAt: existing.createdAt,
      updatedAt: new Date(),
    });

    await this.repo.save(updated);
    return updated.toDetail();
  }

  public async remove(id: string, userId: string): Promise<void> {
    const existing = await this.repo.findDetail(id);
    if (!existing) throw new TemplateNotFoundError(id);

    await this.assertCanManage(existing, userId);
    const deleted = await this.repo.deleteById(existing.id);
    if (!deleted) throw new TemplateNotFoundError(id);
  }

  public async assertCanManage(
    manifest: TemplateManifest,
    userId: string,
    targetVisibility?: string,
  ): Promise<void> {
    const isOp = this.accessConfig?.isOperator(userId) ?? false;
    if (targetVisibility === 'official' && !isOp) {
      throw new TemplateForbiddenError(
        'Only platform operators can publish official gallery templates',
      );
    }
    const canWriteSpace =
      manifest.spaceId && isUuid(manifest.spaceId)
        ? await this.hasSpaceAccess(manifest.spaceId, userId, true)
        : false;

    if (
      !canManageTemplate({
        visibility: manifest.visibility,
        createdById: manifest.createdById,
        userId,
        isOperator: isOp,
        canWriteSpace,
      })
    ) {
      throw new TemplateForbiddenError();
    }
  }

  public async hasSpaceAccess(
    spaceId: string,
    userId: string,
    requireWrite: boolean,
  ): Promise<boolean> {
    if (!spaceId || !userId || !isUuid(spaceId) || !isUuid(userId)) {
      return false;
    }
    if (spaceId.toLowerCase() === userId.toLowerCase()) return true;
    if (!this.access) return true;
    const role = await this.access.getRole(spaceId, userId).catch(() => null);
    if (!role) return false;
    return requireWrite
      ? role === 'owner' || role === 'coordinator' || role === 'contributor'
      : true;
  }
}
