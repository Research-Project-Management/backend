import { Inject, Injectable } from '@nestjs/common';
import {
  ITemplateRepositoryPort,
  TEMPLATE_REPOSITORY_PORT,
} from '../ports/template-repository.port';
import { ManuscriptTemplateEntity } from '../domain/entities/manuscript-template.entity';
import { TemplateNotFoundException } from '../domain/exceptions/template-not-found.exception';

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
