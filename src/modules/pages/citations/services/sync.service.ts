/**
 * citations/services/sync.service.ts
 * Adapter for fetching BibTeX streams from Zotero, Mendeley, or Flux Library.
 */

import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { IntegrationsService } from '@/modules/integrations/integrations.service';
import { LIBRARY_FACADE, ILibraryFacade } from '@/modules/library';
import { ILibrarySyncPort } from '../domain/citations.ports';

@Injectable()
export class LibrarySyncAdapter implements ILibrarySyncPort {
  private readonly logger = new Logger(LibrarySyncAdapter.name);

  constructor(
    @Optional()
    private readonly integrationsService?: IntegrationsService,
    @Optional()
    @Inject(LIBRARY_FACADE)
    private readonly libraryFacade?: ILibraryFacade,
  ) {}

  public async fetchCollectionBibtex(
    userId: string,
    collectionId: string,
    spaceId?: string,
  ): Promise<string> {
    if (
      collectionId.startsWith('zotero:') ||
      collectionId.startsWith('group:')
    ) {
      const rawCollId = collectionId.startsWith('zotero:')
        ? collectionId.replace('zotero:', '')
        : collectionId;

      if (!this.integrationsService) {
        throw new ServiceUnavailableException(
          'Zotero integration services are not configured',
        );
      }

      const res = await this.integrationsService.fetchRemoteCollectionBibtex(
        userId,
        'zotero',
        rawCollId,
      );
      return res.bibtex;
    }

    if (collectionId.startsWith('mendeley:')) {
      const rawCollId = collectionId.replace('mendeley:', '');

      if (!this.integrationsService) {
        throw new ServiceUnavailableException(
          'Mendeley integration services are not configured',
        );
      }

      const res = await this.integrationsService.fetchRemoteCollectionBibtex(
        userId,
        'mendeley',
        rawCollId,
      );
      return res.bibtex;
    }

    if (this.libraryFacade) {
      try {
        const exportRes = await this.libraryFacade.exportLibrary(userId, {
          format: 'bibtex',
          collectionId,
          spaceId,
        });
        if (exportRes?.content !== undefined) {
          return exportRes.content;
        }
      } catch (err: unknown) {
        this.logger.warn(
          `Failed to export collection BibTeX via LibraryFacade: ${(err as Error)?.message}`,
        );
      }
    }

    throw new NotFoundException(`Collection ${collectionId} not found`);
  }
}
