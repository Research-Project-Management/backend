/**
 * export-import/core/use-cases/scaffold-template.use-case.ts
 * Inbound Use Case initializing a fresh manuscript project using an academic starter template.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ITemplateCatalogPort } from '../ports/template-catalog.port';
import { IManuscriptHydratorPort } from '../ports/manuscript-hydrator.port';
import { ImportSummaryVo } from '../domain/value-objects/import-summary.vo';
import { ArchiveEntryVo } from '../domain/value-objects/archive-entry.vo';
import { TemplateNotFoundException } from '../domain/exceptions/template-not-found.exception';

export interface ScaffoldTemplateInput {
  projectId: string;
  templateId: string;
  userId?: string | null;
}

@Injectable()
export class ScaffoldTemplateUseCase {
  private readonly logger = new Logger(ScaffoldTemplateUseCase.name);

  constructor(
    private readonly catalog: ITemplateCatalogPort,
    private readonly hydrator: IManuscriptHydratorPort,
  ) {}

  public async execute(input: ScaffoldTemplateInput): Promise<ImportSummaryVo> {
    const { projectId, templateId, userId } = input;

    const template = await this.catalog.getTemplateById(templateId);
    if (!template) {
      throw new TemplateNotFoundException(templateId);
    }

    const entries: ArchiveEntryVo[] = template.files.map((file) => {
      const data = Buffer.isBuffer(file.content)
        ? file.content
        : Buffer.from(file.content, 'utf8');
      return ArchiveEntryVo.create(file.path, data, false);
    });

    return await this.hydrator.hydrateProjectEntries(
      projectId,
      entries,
      userId,
      template.defaultRootDoc,
    );
  }
}
