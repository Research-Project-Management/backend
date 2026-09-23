import { Injectable, Optional } from '@nestjs/common';
import { CitationService } from './application/services/citation.service';
import { ExportsService } from './application/services/exports.service';

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
    @Optional() private readonly citationService?: CitationService,
    @Optional() private readonly exportsService?: ExportsService,
  ) {}

  async formatCitation(
    userId: string,
    itemId: string,
    styleId = 'apa',
  ): Promise<any> {
    if (!this.citationService) return null;
    return this.citationService.formatItemById(userId, itemId, styleId as any);
  }

  async exportBibliography(
    userId: string,
    citeKeys: string[],
    projectId?: string,
  ): Promise<{ content: string } | null> {
    if (!this.exportsService) return null;
    const res = await this.exportsService.exportByCitationKeys(
      userId,
      citeKeys,
      projectId,
    );
    if (!res || !res.content) return null;
    return { content: res.content };
  }

  async exportLibrary(userId: string, options?: any): Promise<any> {
    if (!this.exportsService) return null;
    return this.exportsService.exportLibrary(userId, options);
  }
}
