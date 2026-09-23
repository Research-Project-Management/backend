/**
 * export-import/core/use-cases/list-templates.use-case.ts
 * Inbound Use Case retrieving all pre-configured academic project templates for the Gallery UI.
 */

import { Injectable } from '@nestjs/common';
import { ITemplateCatalogPort } from '../ports/template-catalog.port';
import { ProjectTemplate } from '../domain/entities/project-template.entity';

@Injectable()
export class ListTemplatesUseCase {
  constructor(private readonly catalog: ITemplateCatalogPort) {}

  public async execute(): Promise<ProjectTemplate[]> {
    return await this.catalog.listTemplates();
  }
}
