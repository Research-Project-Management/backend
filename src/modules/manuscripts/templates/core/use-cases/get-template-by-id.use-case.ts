import { Inject, Injectable } from '@nestjs/common';
import {
  ITemplateRepositoryPort,
  TEMPLATE_REPOSITORY_PORT,
} from '@/modules/manuscripts/templates/core/ports/template-repository.port';
import { ManuscriptTemplateEntity } from '@/modules/manuscripts/templates/core/domain/entities/manuscript-template.entity';
import { TemplateNotFoundException } from '@/modules/manuscripts/templates/core/domain/exceptions/template-not-found.exception';

@Injectable()
export class GetTemplateByIdUseCase {
  constructor(
    @Inject(TEMPLATE_REPOSITORY_PORT)
    private readonly templateRepository: ITemplateRepositoryPort,
  ) {}

  async execute(idOrVersionId: string): Promise<ManuscriptTemplateEntity> {
    if (!idOrVersionId || !idOrVersionId.trim()) {
      throw new TemplateNotFoundException('empty-id');
    }

    // Try finding by ID first
    let template = await this.templateRepository.findById(idOrVersionId);
    if (!template) {
      // Fallback to version ID
      template = await this.templateRepository.findByVersionId(idOrVersionId);
    }

    if (!template) {
      throw new TemplateNotFoundException(idOrVersionId);
    }

    return template;
  }
}
