/**
 * citations/citations.service.ts
 * Facade Service orchestrating Citations, BibTeX, DOI/arXiv resolution & Library sync.
 */

import { Injectable, Logger, Inject } from '@nestjs/common';
import { SearchCitationKeysUseCase } from './core/use-cases/search-citation-keys.use-case';
import { ResolveIdentifierToBibUseCase } from './core/use-cases/resolve-identifier-to-bib.use-case';
import { ValidateProjectBibtexUseCase } from './core/use-cases/validate-project-bibtex.use-case';
import { SyncLibraryCollectionUseCase } from './core/use-cases/sync-library-collection.use-case';
import { IBibtexParserPort, BIBTEX_PARSER_PORT } from './core/ports/bibtex-parser.port';
import {
  CitationQueryDto,
  ResolveIdentifierDto,
  SyncLibraryDto,
  BibEntryDto,
  CitationValidationDto,
  SyncLibraryResultDto,
} from './dto/citations.dto';

@Injectable()
export class CitationsService {
  private readonly logger = new Logger(CitationsService.name);

  constructor(
    private readonly searchKeysUseCase: SearchCitationKeysUseCase,
    private readonly resolveIdentifierUseCase: ResolveIdentifierToBibUseCase,
    private readonly validateBibtexUseCase: ValidateProjectBibtexUseCase,
    private readonly syncLibraryUseCase: SyncLibraryCollectionUseCase,
    @Inject(BIBTEX_PARSER_PORT)
    private readonly bibParser: IBibtexParserPort
  ) {}

  /**
   * Search citation keys in the project to power \cite{...} autocomplete.
   */
  public async searchCitationKeys(
    projectId: string,
    queryDto: CitationQueryDto
  ): Promise<BibEntryDto[]> {
    const entries = await this.searchKeysUseCase.execute({
      projectId,
      query: queryDto.query,
      limit: queryDto.limit,
    });

    return entries.map((e) => e.toJSON() as BibEntryDto);
  }

  /**
   * Resolve DOI or arXiv identifier and append to project .bib file.
   */
  public async resolveIdentifier(
    projectId: string,
    dto: ResolveIdentifierDto
  ): Promise<{ entry: BibEntryDto; filePath: string; identifierType: string }> {
    const res = await this.resolveIdentifierUseCase.execute({
      projectId,
      identifier: dto.identifier,
      targetBibFile: dto.targetBibFile,
    });

    return {
      entry: res.entry.toJSON() as BibEntryDto,
      filePath: res.filePath,
      identifierType: res.identifierType,
    };
  }

  /**
   * Validate all .bib files in project for duplicates or syntax issues.
   */
  public async validateProjectBibtex(projectId: string): Promise<CitationValidationDto> {
    return this.validateBibtexUseCase.execute(projectId);
  }

  /**
   * Sync reference collection from external library (Zotero / Flux Library).
   */
  public async syncLibraryCollection(
    projectId: string,
    userId: string,
    dto: SyncLibraryDto
  ): Promise<SyncLibraryResultDto> {
    return this.syncLibraryUseCase.execute({
      projectId,
      userId,
      collectionId: dto.collectionId,
      targetFilename: dto.targetFilename,
    });
  }

  /**
   * List available collections for user from external library.
   */
  public async listUserLibraryCollections(userId: string) {
    return this.syncLibraryUseCase.listUserCollections(userId);
  }

  /**
   * Parse raw BibTeX text in memory.
   */
  public parseRawBibtex(rawText: string): BibEntryDto[] {
    const entries = this.bibParser.parse(rawText);
    return entries.map((e) => e.toJSON() as BibEntryDto);
  }
}
