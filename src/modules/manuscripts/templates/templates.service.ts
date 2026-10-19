/**
 * templates/templates.service.ts
 * Deep Module Service for Manuscripts Templates.
 * Consolidates template listing, search, lookup, instantiation, and custom template creation.
 */

import { Injectable, Logger } from '@nestjs/common';
import { TemplatesRepository } from './templates.repository';
import {
  ManuscriptTemplateEntity,
  TemplateNotFoundException,
  InvalidTemplateException,
} from './domain';
import {
  QueryTemplatesDto,
  SearchTemplatesDto,
  InstantiateTemplateDto,
  CreateTemplateDto,
} from './dto/template.dto';

@Injectable()
export class TemplatesService {
  private readonly logger = new Logger(TemplatesService.name);

  constructor(private readonly repository: TemplatesRepository) {}

  async listTemplates(dto?: QueryTemplatesDto) {
    if (dto?.search) {
      return this.searchTemplates({
        q: dto.search,
        category: dto.category,
        limit: dto.limit,
        offset: dto.offset ?? dto.skip,
      });
    }

    const result = await this.repository.findAll({
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

    let template = await this.repository.findById(idOrVersionId);
    if (!template) {
      template = await this.repository.findByVersionId(idOrVersionId);
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
    const result = await this.repository.search({
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

  async instantiateTemplate(
    userId: string,
    dto:
      | InstantiateTemplateDto
      | {
          templateId?: string;
          template_id?: string;
          templateVersionId?: string;
          id?: string;
          projectName?: string;
          project_name?: string;
          name?: string;
        },
  ) {
    const templateId =
      ('templateId' in dto ? dto.templateId : undefined) ||
      ('template_id' in dto ? dto.template_id : undefined) ||
      ('templateVersionId' in dto ? dto.templateVersionId : undefined) ||
      ('id' in dto ? dto.id : undefined);
    const projectName =
      ('projectName' in dto ? dto.projectName : undefined) ||
      ('name' in dto
        ? dto.name
        : 'project_name' in dto
          ? dto.project_name
          : undefined);

    if (!templateId) {
      throw new InvalidTemplateException('Template ID must be specified.');
    }

    const template = await this.getTemplateEntity(templateId);
    const resolvedName = projectName || template.name;

    const result = await this.repository.instantiate({
      template,
      projectName: resolvedName,
      userId,
    });

    // Increment download count in background without blocking project return
    this.repository.incrementDownloadCount(template.id).catch(() => {
      // ignore telemetry failure
    });

    return result;
  }

  async createCustomTemplate(dto: CreateTemplateDto) {
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

    const saved = await this.repository.save(template);
    return saved.toPlainObject();
  }
}
