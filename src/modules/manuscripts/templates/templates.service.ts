import { Injectable, Logger } from '@nestjs/common';
import { ListTemplatesUseCase } from './core/use-cases/list-templates.use-case';
import { GetTemplateByIdUseCase } from './core/use-cases/get-template-by-id.use-case';
import { SearchTemplatesUseCase } from './core/use-cases/search-templates.use-case';
import { InstantiateTemplateUseCase } from './core/use-cases/instantiate-template.use-case';
import { CreateCustomTemplateUseCase } from './core/use-cases/create-custom-template.use-case';
import {
  QueryTemplatesDto,
  SearchTemplatesDto,
  InstantiateTemplateDto,
  CreateTemplateDto,
} from './dto/template.dto';

@Injectable()
export class TemplatesService {
  private readonly logger = new Logger(TemplatesService.name);

  constructor(
    private readonly listTemplatesUseCase: ListTemplatesUseCase,
    private readonly getTemplateByIdUseCase: GetTemplateByIdUseCase,
    private readonly searchTemplatesUseCase: SearchTemplatesUseCase,
    private readonly instantiateTemplateUseCase: InstantiateTemplateUseCase,
    private readonly createCustomTemplateUseCase: CreateCustomTemplateUseCase,
  ) {}

  async listTemplates(dto?: QueryTemplatesDto) {
    const result = await this.listTemplatesUseCase.execute({
      category: dto?.category,
      isOfficial: dto?.isOfficial,
      tag: dto?.tag,
      limit: dto?.limit,
      offset: dto?.offset,
    });

    return {
      templates: result.templates.map((t) => t.toPlainObject()),
      total: result.total,
    };
  }

  async getTemplate(idOrVersionId: string) {
    const entity = await this.getTemplateByIdUseCase.execute(idOrVersionId);
    return entity.toPlainObject();
  }

  async searchTemplates(dto: SearchTemplatesDto) {
    const result = await this.searchTemplatesUseCase.execute({
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

  async instantiateTemplate(userId: string, dto: InstantiateTemplateDto) {
    const template = await this.getTemplateByIdUseCase.execute(dto.templateId);
    const projectName = dto.projectName || template.name;

    return this.instantiateTemplateUseCase.execute({
      templateIdOrVersionId: dto.templateId,
      projectName,
      userId,
    });
  }

  async createCustomTemplate(dto: CreateTemplateDto) {
    const entity = await this.createCustomTemplateUseCase.execute({
      name: dto.name,
      category: dto.category,
      description: dto.description,
      compiler: dto.compiler,
      imageName: dto.imageName,
      mainFile: dto.mainFile,
      thumbnailUrl: dto.thumbnailUrl,
      author: dto.author,
      tags: dto.tags,
      files: dto.files,
    });

    return entity.toPlainObject();
  }
}
