import { Injectable } from '@nestjs/common';
import { CitationService } from './services/citation.service';
import { ExportsService } from './services/exports.service';

export const CITATION_FACADE = 'CITATION_FACADE';

export interface ICitationFacade {
  formatCitation(
    userId: string,
    itemId: string,
    styleId?: string,
  ): Promise<any>;
  exportBibliography(
    userId: string,
    citeKeys: string[],
    projectId?: string,
  ): Promise<{ content: string } | null>;
  exportLibrary(userId: string, options?: any): Promise<any>;
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
    styleId = 'apa',
  ): Promise<any> {
    return this.citationService.formatItemById(userId, itemId, styleId);
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

  async exportLibrary(userId: string, options?: any): Promise<any> {
    return this.exportsService.exportLibrary(userId, options);
  }
}
