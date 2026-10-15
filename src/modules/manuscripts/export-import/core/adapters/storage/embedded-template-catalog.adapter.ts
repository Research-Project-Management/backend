/**
 * export-import/core/adapters/storage/embedded-template-catalog.adapter.ts
 * Driven Adapter managing a catalog of embedded international academic LaTeX templates.
 * Shares canonical template definitions and aliases with TemplatesModule via OFFICIAL_TEMPLATE_CATALOG.
 */

import { Injectable } from '@nestjs/common';
import { ITemplateCatalogPort } from '@/modules/manuscripts/export-import/core/ports/template-catalog.port';
import { ProjectTemplate } from '@/modules/manuscripts/export-import/core/domain/entities/project-template.entity';
import { OFFICIAL_TEMPLATE_CATALOG } from '@/modules/manuscripts/templates/domain';

@Injectable()
export class EmbeddedTemplateCatalogAdapter extends ITemplateCatalogPort {
  private readonly templates: Map<string, ProjectTemplate> = new Map();
  private readonly aliasIndex: Map<string, ProjectTemplate> = new Map();

  constructor() {
    super();
    this.seedDefaultTemplates();
  }

  public async listTemplates(): Promise<ProjectTemplate[]> {
    return Array.from(this.templates.values());
  }

  public async getTemplateById(
    templateId: string,
  ): Promise<ProjectTemplate | null> {
    if (!templateId) return null;
    const direct = this.templates.get(templateId);
    if (direct) return direct;
    return (
      this.aliasIndex.get(templateId) ||
      this.aliasIndex.get(templateId.toLowerCase().trim()) ||
      null
    );
  }

  private seedDefaultTemplates(): void {
    for (const def of OFFICIAL_TEMPLATE_CATALOG) {
      const files = Object.entries(def.files).map(([path, content]) => ({
        path,
        content,
      }));
      // Ensure main.tex exists if the template uses a custom mainFile (e.g. bare_jrnl.tex)
      if (!files.some((f) => f.path === 'main.tex')) {
        const rootContent =
          def.files[def.mainFile] || Object.values(def.files)[0] || '';
        files.push({ path: 'main.tex', content: rootContent });
      }

      const template = new ProjectTemplate({
        id: def.slug,
        title: def.title,
        category: def.category,
        description: def.description,
        author: def.author,
        defaultRootDoc:
          def.slug === 'ieee-transactions'
            ? 'main.tex'
            : def.mainFile || 'main.tex',
        files,
      });

      this.templates.set(def.slug, template);
      this.aliasIndex.set(def.slug.toLowerCase(), template);
      this.aliasIndex.set(def.id, template);
      this.aliasIndex.set(def.id.toLowerCase(), template);
      this.aliasIndex.set(def.versionId, template);
      this.aliasIndex.set(def.versionId.toLowerCase(), template);
      for (const alias of def.aliases) {
        this.aliasIndex.set(alias.toLowerCase(), template);
      }
    }
  }
}
