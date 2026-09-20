import { Injectable, Logger } from '@nestjs/common';
import { ExportsService } from '../services/exports.service';

export interface ExportBibliographyQuery {
  userId: string;
  citeKeys: string[];
  projectId?: string;
}

/**
 * Query Use Case — Export Bibliography By Citation Keys
 *
 * Clean Architecture & CQRS:
 * Extracts BibTeX entries matching given citeKeys for document rendering.
 */
@Injectable()
export class ExportBibliographyUseCase {
  private readonly logger = new Logger(ExportBibliographyUseCase.name);

  constructor(private readonly exportsService: ExportsService) {}

  async execute(
    query: ExportBibliographyQuery,
  ): Promise<{ content: string } | null> {
    this.logger.debug(
      `Executing ExportBibliographyUseCase for user ${query.userId} (${query.citeKeys.length} keys)`,
    );
    return this.exportsService.exportByCitationKeys(
      query.userId,
      query.citeKeys,
      query.projectId,
    );
  }
}
