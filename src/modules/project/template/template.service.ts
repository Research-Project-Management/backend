import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { ProjectTemplate } from '@prisma/client';
import { TemplateRepository } from './template.repository';
import { CoreRepository } from '../core/core.repository';
import { CreateProjectTemplateDto } from './dto/create-template.dto';
import { InstantiateProjectTemplateDto } from './dto/instantiate-template.dto';
import { deriveProjectPrefix } from '../core/utils/identifier.util';

@Injectable()
export class TemplateService {
  constructor(
    private readonly templateRepo: TemplateRepository,
    private readonly coreRepo: CoreRepository,
  ) {}

  async listTemplates(userId: string): Promise<ProjectTemplate[]> {
    return this.templateRepo.findAccessibleTemplates(userId);
  }

  async getTemplateById(id: string, userId?: string): Promise<ProjectTemplate> {
    const template = await this.templateRepo.findTemplateById(id);
    if (!template) {
      throw new NotFoundException(`Project template with ID "${id}" not found`);
    }
    if (userId && !template.isPublic && template.createdById !== userId) {
      throw new ForbiddenException('You do not have access to this private template');
    }
    return template;
  }

  async createTemplate(
    userId: string,
    dto: CreateProjectTemplateDto,
  ): Promise<ProjectTemplate> {
    return this.templateRepo.createTemplate(userId, dto);
  }

  async updateTemplate(
    id: string,
    userId: string,
    dto: Partial<CreateProjectTemplateDto>,
  ): Promise<ProjectTemplate> {
    const template = await this.getTemplateById(id);
    if (template.createdById !== userId) {
      throw new ForbiddenException(
        'Only the template creator can modify this template',
      );
    }
    return this.templateRepo.updateTemplate(id, dto);
  }

  async deleteTemplate(
    id: string,
    userId: string,
  ): Promise<{ message: string }> {
    const template = await this.getTemplateById(id);
    if (template.createdById !== userId) {
      throw new ForbiddenException(
        'Only the template creator can delete this template',
      );
    }
    await this.templateRepo.deleteTemplate(id);
    return { message: 'Project template deleted successfully' };
  }

  /**
   * Instantiate a new project from a Project Template.
   * Atomically sets up Project, Owner membership, initial states, labels, and initial work items.
   */
  async instantiate(
    templateId: string,
    userId: string,
    dto: InstantiateProjectTemplateDto,
  ) {
    const template = await this.getTemplateById(templateId, userId);
    const baseIdentifier = deriveProjectPrefix(dto.identifier, dto.name);
    const identifier = await this.coreRepo.findAvailableIdentifier(baseIdentifier, userId);
    return this.templateRepo.instantiateProject(
      template,
      userId,
      identifier,
      dto,
    );
  }
}
