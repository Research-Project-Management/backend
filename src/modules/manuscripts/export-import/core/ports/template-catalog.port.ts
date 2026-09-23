/**
 * export-import/core/ports/template-catalog.port.ts
 * Outbound Port (SPI) for listing and retrieving academic LaTeX project starter templates.
 */

import { ProjectTemplate } from '../domain/entities/project-template.entity';

export abstract class ITemplateCatalogPort {
  /**
   * Retrieves all pre-configured academic project templates.
   */
  abstract listTemplates(): Promise<ProjectTemplate[]>;

  /**
   * Retrieves a specific template by its identifier.
   */
  abstract getTemplateById(templateId: string): Promise<ProjectTemplate | null>;
}
