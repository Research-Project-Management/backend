import { Inject, Injectable } from '@nestjs/common';
import {
  ITemplateRepositoryPort,
  TEMPLATE_REPOSITORY_PORT,
} from '../ports/template-repository.port';
import {
  IProjectInstantiatorPort,
  PROJECT_INSTANTIATOR_PORT,
  InstantiatedProjectResult,
} from '../ports/project-instantiator.port';
import { GetTemplateByIdUseCase } from './get-template-by-id.use-case';

export interface InstantiateTemplateCommand {
  templateIdOrVersionId: string;
  projectName: string;
  userId: string;
}

@Injectable()
export class InstantiateTemplateUseCase {
  constructor(
    @Inject(TEMPLATE_REPOSITORY_PORT)
    private readonly templateRepository: ITemplateRepositoryPort,
    @Inject(PROJECT_INSTANTIATOR_PORT)
    private readonly projectInstantiator: IProjectInstantiatorPort,
    private readonly getTemplateByIdUseCase: GetTemplateByIdUseCase,
  ) {}

  async execute(command: InstantiateTemplateCommand): Promise<InstantiatedProjectResult> {
    const template = await this.getTemplateByIdUseCase.execute(command.templateIdOrVersionId);

    const result = await this.projectInstantiator.instantiate({
      template,
      projectName: command.projectName,
      userId: command.userId,
    });

    // Increment download count in background without blocking project return
    this.templateRepository.incrementDownloadCount(template.id).catch(() => {
      // ignore telemetry failure
    });

    return result;
  }
}
