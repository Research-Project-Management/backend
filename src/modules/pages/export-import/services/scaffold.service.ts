import { Injectable, Optional } from '@nestjs/common';
import { TemplatesService } from '@/modules/pages/templates/templates.service';
import { TemplateNotFoundException } from '@/modules/pages/templates/domain';
import { ArchiveEntryVo } from '../domain/archive.domain';
import { PageArchiveHydratorAdapter } from '../adapters/hydrator.adapter';
import { ImportSummaryResponseDto } from '../dto/import.dto';

@Injectable()
export class ScaffoldService {
  constructor(
    private readonly hydrator: PageArchiveHydratorAdapter,
    @Optional() private readonly templatesService?: TemplatesService,
  ) {}

  public async scaffoldTemplate(
    projectId: string,
    templateId: string,
    userId?: string | null,
    pageId?: string,
  ): Promise<ImportSummaryResponseDto> {
    if (!this.templatesService) {
      throw new TemplateNotFoundException(templateId);
    }

    const template = await this.templatesService.getTemplate(templateId);
    if (!template) {
      throw new TemplateNotFoundException(templateId);
    }

    const entries: ArchiveEntryVo[] = Object.entries(template.files || {}).map(
      ([filePath, content]) => {
        const data = Buffer.isBuffer(content)
          ? content
          : Buffer.from(String(content), 'utf8');
        return ArchiveEntryVo.create(filePath, data, false);
      },
    );

    const summary = await this.hydrator.hydrateProjectEntries(
      projectId,
      entries,
      userId,
      template.mainFile || 'main.tex',
      pageId,
    );
    return summary.toJSON();
  }
}
