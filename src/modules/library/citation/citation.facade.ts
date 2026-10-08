import { Injectable } from '@nestjs/common';
import { CitationService } from './services/citation.service';
import { ExportsService } from './services/exports.service';
import {
  FormattedCitationResult,
  CitationStyleId,
} from './types/citation.types';
import { ExportLibraryDto } from './dto/exports.dto';
import { ExportResult } from './types/exports.types';

export const CITATION_FACADE = 'CITATION_FACADE';

export interface ICitationFacade {
  formatCitation(
    userId: string,
    itemId: string,
    styleId?: CitationStyleId,
    index?: number,
    projectId?: string,
  ): Promise<FormattedCitationResult>;
  exportBibliography(
    userId: string,
    citeKeys: string[],
    projectId?: string,
  ): Promise<{ content: string } | null>;
  exportLibrary(
    userId: string,
    options?: ExportLibraryDto,
  ): Promise<ExportResult>;
}

@Injectable()
export class CitationFacade implements ICitationFacade {
  constructor(
    private readonly citationService: CitationService,
    private readonly exportsService: ExportsService,
  ) {}

  async formatCitation(
    userId: string,
    itemId: string,
    styleId: CitationStyleId = 'apa-7th',
    index: number = 1,
    projectId?: string,
  ): Promise<FormattedCitationResult> {
    return this.citationService.formatItemById(
      userId,
      itemId,
      styleId,
      index,
      projectId,
    );
  }

  async exportBibliography(
    userId: string,
    citeKeys: string[],
    projectId?: string,
  ): Promise<{ content: string } | null> {
    const res = await this.exportsService.exportByCitationKeys(
      userId,
      citeKeys,
      projectId,
    );
    if (!res || !res.content) return null;
    return { content: res.content };
  }

  async exportLibrary(
    userId: string,
    options: ExportLibraryDto = { format: 'bibtex' },
  ): Promise<ExportResult> {
    return this.exportsService.exportLibrary(userId, options);
  }
}
