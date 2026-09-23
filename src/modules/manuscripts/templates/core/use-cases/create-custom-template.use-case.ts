import { Inject, Injectable } from '@nestjs/common';
import {
  ITemplateRepositoryPort,
  TEMPLATE_REPOSITORY_PORT,
} from '../ports/template-repository.port';
import {
  ManuscriptTemplateEntity,
  CreateManuscriptTemplateProps,
} from '../domain/entities/manuscript-template.entity';
import { InvalidTemplateException } from '../domain/exceptions/invalid-template.exception';

@Injectable()
export class CreateCustomTemplateUseCase {
  constructor(
    @Inject(TEMPLATE_REPOSITORY_PORT)
    private readonly templateRepository: ITemplateRepositoryPort,
  ) {}

  async execute(props: CreateManuscriptTemplateProps): Promise<ManuscriptTemplateEntity> {
    if (!props.name || !props.name.trim()) {
      throw new InvalidTemplateException('Template name is required and cannot be empty');
    }

    const mainFile = props.mainFile || 'main.tex';
    const files = props.files || {};

    if (Object.keys(files).length > 0 && !files[mainFile]) {
      throw new InvalidTemplateException(`Specified mainFile "${mainFile}" does not exist in template files payload`);
    }

    const template = ManuscriptTemplateEntity.create({
      ...props,
      mainFile,
      isOfficial: false, // Custom templates default to community/non-official
    });

    return this.templateRepository.save(template);
  }
}
