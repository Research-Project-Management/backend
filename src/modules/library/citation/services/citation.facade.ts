import { Injectable } from '@nestjs/common';
import {
  CITATION_FACADE,
  ICitationFacade as ICoreCitationFacade,
} from '@/modules/library/core';
import {
  CitationStyleId,
  FormattedCitationResult,
  ExportResult,
} from '@/modules/library/citation/types/citation.types';
import { ExportLibraryDto } from '@/modules/library/citation/dto/citation.dto';
import { CitationService } from './citation.service';
import { ExportsService } from './exports.service';

export { CITATION_FACADE };
export type ICitationFacade = ICoreCitationFacade<
  CitationStyleId,
  FormattedCitationResult,
  ExportLibraryDto,
  ExportResult
>;

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

  async exportByCitationKeys(
    userId: string,
    citeKeys: string[],
    projectId?: string,
  ): Promise<{
    content: string;
    count: number;
    foundKeys: string[];
    missingKeys: string[];
  }> {
    return this.exportsService.exportByCitationKeys(
      userId,
      citeKeys,
      projectId,
    );
  }

  async exportLibrary(
    userId: string,
    options: ExportLibraryDto = { format: 'bibtex' },
  ): Promise<ExportResult> {
    return this.exportsService.exportLibrary(userId, options);
  }
}
