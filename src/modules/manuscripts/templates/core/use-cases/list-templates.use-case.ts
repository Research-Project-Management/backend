import { Inject, Injectable } from '@nestjs/common';
import {
  ITemplateRepositoryPort,
  TEMPLATE_REPOSITORY_PORT,
  FindTemplatesFilter,
  FindTemplatesResult,
} from '@/modules/manuscripts/templates/core/ports/template-repository.port';

@Injectable()
export class ListTemplatesUseCase {
  constructor(
    @Inject(TEMPLATE_REPOSITORY_PORT)
    private readonly templateRepository: ITemplateRepositoryPort,
  ) {}

  async execute(filter?: FindTemplatesFilter): Promise<FindTemplatesResult> {
    return this.templateRepository.findAll(filter);
  }
}
