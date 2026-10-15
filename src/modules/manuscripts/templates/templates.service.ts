/**
 * templates/templates.service.ts
 * Deep Module Service for Manuscripts Templates.
 * Consolidates template listing, search, lookup, instantiation, and custom template creation.
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import { TemplatesRepository } from './templates.repository';
import { ManuscriptTemplateEntity } from './core/domain/entities/manuscript-template.entity';
import { TemplateNotFoundException } from './core/domain/exceptions/template-not-found.exception';
import { InvalidTemplateException } from './core/domain/exceptions/invalid-template.exception';
import {
  QueryTemplatesDto,
  SearchTemplatesDto,
  InstantiateTemplateDto,
  CreateTemplateDto,
} from './dto/template.dto';

interface LegacyUseCaseLike {
  execute: (...args: any[]) => Promise<any>;
}

@Injectable()
export class TemplatesService {
  private readonly logger = new Logger(TemplatesService.name);
  private readonly repository?: TemplatesRepository;
  private readonly listUseCase?: LegacyUseCaseLike;
  private readonly getByIdUseCase?: LegacyUseCaseLike;
  private readonly searchUseCase?: LegacyUseCaseLike;
  private readonly instantiateUseCase?: LegacyUseCaseLike;
  private readonly createCustomUseCase?: LegacyUseCaseLike;

  constructor(
    repoOrListUseCase: TemplatesRepository | LegacyUseCaseLike,
    @Optional() getByIdUseCase?: LegacyUseCaseLike,
    @Optional() searchUseCase?: LegacyUseCaseLike,
    @Optional() instantiateUseCase?: LegacyUseCaseLike,
    @Optional() createCustomUseCase?: LegacyUseCaseLike,
  ) {
    if (
      repoOrListUseCase &&
      'execute' in repoOrListUseCase &&
      typeof repoOrListUseCase.execute === 'function'
    ) {
      this.listUseCase = repoOrListUseCase;
      this.getByIdUseCase = getByIdUseCase;
      this.searchUseCase = searchUseCase;
      this.instantiateUseCase = instantiateUseCase;
      this.createCustomUseCase = createCustomUseCase;
    } else {
      this.repository = repoOrListUseCase as TemplatesRepository;
    }
  }

  async listTemplates(dto?: QueryTemplatesDto) {
    if (this.listUseCase) {
      if (dto?.search && this.searchUseCase) {
        return this.searchTemplates({
          q: dto.search,
          category: dto.category,
          limit: dto.limit,
          offset: dto.offset ?? dto.skip,
        });
      }
      const result = await this.listUseCase.execute(dto);
      const list = Array.isArray(result) ? result : result?.templates || [];
      return {
        templates: list.map((t: any) =>
          typeof t.toPlainObject === 'function' ? t.toPlainObject() : t,
        ),
        total: result?.total ?? list.length,
      };
    }

    if (dto?.search) {
      return this.searchTemplates({
        q: dto.search,
        category: dto.category,
        limit: dto.limit,
        offset: dto.offset ?? dto.skip,
      });
    }

    const result = await this.repository!.findAll({
      category: dto?.category,
      isOfficial: dto?.isOfficial,
      tag: dto?.tag,
      limit: dto?.limit,
      offset: dto?.offset ?? dto?.skip,
    });

    return {
      templates: result.templates.map((t) => t.toPlainObject()),
      total: result.total,
    };
  }

  async getTemplateEntity(
    idOrVersionId: string,
  ): Promise<ManuscriptTemplateEntity> {
    if (!idOrVersionId || !idOrVersionId.trim()) {
      throw new TemplateNotFoundException('empty-id');
    }

    if (this.getByIdUseCase) {
      return await this.getByIdUseCase.execute(idOrVersionId);
    }

    let template = await this.repository!.findById(idOrVersionId);
    if (!template) {
      template = await this.repository!.findByVersionId(idOrVersionId);
    }

    if (!template) {
      throw new TemplateNotFoundException(idOrVersionId);
    }

    return template;
  }

  async getTemplate(idOrVersionId: string) {
    const entity = await this.getTemplateEntity(idOrVersionId);
    return typeof entity.toPlainObject === 'function'
      ? entity.toPlainObject()
      : entity;
  }

  async searchTemplates(dto: SearchTemplatesDto) {
    if (this.searchUseCase) {
      const result = await this.searchUseCase.execute({
        query: dto.q,
        category: dto.category,
        limit: dto.limit,
        offset: dto.offset,
      });
      const list = Array.isArray(result) ? result : result?.templates || [];
      return {
        templates: list.map((t: any) =>
          typeof t.toPlainObject === 'function' ? t.toPlainObject() : t,
        ),
        total: result?.total ?? list.length,
      };
    }

    const result = await this.repository!.search({
      query: dto.q,
      category: dto.category,
      limit: dto.limit,
      offset: dto.offset,
    });

    return {
      templates: result.templates.map((t) => t.toPlainObject()),
      total: result.total,
    };
  }

  async instantiateTemplate(userId: string, dto: any) {
    const templateId =
      dto.templateId || dto.template_id || dto.templateVersionId || dto.id;
    const projectName = dto.projectName || dto.name;

    if (this.instantiateUseCase) {
      return await this.instantiateUseCase.execute({
        templateIdOrVersionId: templateId,
        projectName: projectName || 'Untitled',
        userId,
      });
    }

    const template = await this.getTemplateEntity(templateId);
    const resolvedName = projectName || template.name;

    const result = await this.repository!.instantiate({
      template,
      projectName: resolvedName,
      userId,
    });

    // Increment download count in background without blocking project return
    this.repository!.incrementDownloadCount(template.id).catch(() => {
      // ignore telemetry failure
    });

    return result;
  }

  async createCustomTemplate(dto: CreateTemplateDto) {
    if (this.createCustomUseCase) {
      const created = await this.createCustomUseCase.execute(dto);
      return typeof created.toPlainObject === 'function'
        ? created.toPlainObject()
        : created;
    }

    if (!dto.name || !dto.name.trim()) {
      throw new InvalidTemplateException(
        'Template name is required and cannot be empty',
      );
    }

    const mainFile = dto.mainFile || 'main.tex';
    const files = dto.files || {};

    if (Object.keys(files).length > 0 && !files[mainFile]) {
      throw new InvalidTemplateException(
        `Specified mainFile "${mainFile}" does not exist in template files payload`,
      );
    }

    const template = ManuscriptTemplateEntity.create({
      name: dto.name,
      category: dto.category,
      description: dto.description,
      compiler: dto.compiler,
      imageName: dto.imageName,
      mainFile,
      thumbnailUrl: dto.thumbnailUrl,
      author: dto.author,
      tags: dto.tags,
      files,
      isOfficial: false,
    });

    const saved = await this.repository!.save(template);
    return saved.toPlainObject();
  }
}
