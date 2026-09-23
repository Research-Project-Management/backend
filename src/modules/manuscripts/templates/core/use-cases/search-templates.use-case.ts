import { Inject, Injectable } from '@nestjs/common';
import {
  ITemplateRepositoryPort,
  TEMPLATE_REPOSITORY_PORT,
  SearchTemplatesFilter,
  FindTemplatesResult,
} from '../ports/template-repository.port';

@Injectable()
export class SearchTemplatesUseCase {
  constructor(
    @Inject(TEMPLATE_REPOSITORY_PORT)
    private readonly templateRepository: ITemplateRepositoryPort,
  ) {}

  async execute(filter: SearchTemplatesFilter): Promise<FindTemplatesResult> {
    return this.templateRepository.search(filter);
  }
}
