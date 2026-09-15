import { Injectable, Optional } from '@nestjs/common';
import { ExportsService } from './exports/exports.service';

export interface ILibraryFacade {
  exportBibByCitationKeys(
    userId: string,
    citeKeys: string[],
  ): Promise<{ content: string } | null>;
}

export const LIBRARY_FACADE = 'LIBRARY_FACADE';

@Injectable()
export class LibraryFacade implements ILibraryFacade {
  constructor(
    @Optional()
    private readonly exportsService?: ExportsService,
  ) {}

  async exportBibByCitationKeys(
    userId: string,
    citeKeys: string[],
  ): Promise<{ content: string } | null> {
    if (!this.exportsService) {
      return null;
    }
    const res = await this.exportsService.exportByCitationKeys(
      userId,
      citeKeys,
    );
    if (!res || !res.content) {
      return null;
    }
    return { content: res.content };
  }
}
