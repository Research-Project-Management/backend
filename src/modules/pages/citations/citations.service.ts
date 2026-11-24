/**
 * citations/citations.service.ts
 * Service orchestrating project .bib citations, DOI/arXiv resolution, and Library sync.
 */

import {
  Injectable,
  Optional,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import { CitationsRepository } from './citations.repository';
import { DoiContentNegotiationService } from '@/modules/library/citation/services/doi-negotiation.service';
import {
  IdentifierVo,
  BibEntry,
  IdentifierResolver,
  IIdentifierResolverPort,
  IdentifierNotFoundException,
  BibtexParser,
  buildBibEntryFromInput,
} from './domain';
import {
  CitationQueryDto,
  ResolveIdentifierDto,
  SyncLibraryDto,
  CitationEntryDto,
  ListCitationsResponseDto,
  BibMutationResponseDto,
  UpsertCitationEntriesDto,
} from './dto/citations.dto';

@Injectable()
export class CitationsService {
  private readonly logger = new Logger(CitationsService.name);
  private readonly bibParser: BibtexParser;
  private readonly identifierResolver: IIdentifierResolverPort;

  constructor(
    private readonly repository: CitationsRepository,
    @Optional() bibParser?: BibtexParser,
    @Optional() identifierResolver?: IdentifierResolver,
    @Optional()
    private readonly doiNegotiation?: DoiContentNegotiationService,
  ) {
    this.bibParser = bibParser ?? new BibtexParser();
    this.identifierResolver = identifierResolver ?? new IdentifierResolver();
  }

  /**
   * List or search citation entries across all .bib files in the project.
   */
  public async listCitations(
    projectId: string,
    queryDto: CitationQueryDto,
    pageId?: string,
  ): Promise<ListCitationsResponseDto> {
    const bibFiles = await this.repository.collectBibFiles(
      projectId,
      pageId ?? queryDto.pageId,
    );
    const term = (queryDto.query || '').trim().toLowerCase();
    const limit = queryDto.limit ?? 500;

    const allMatches: CitationEntryDto[] = [];
    for (const file of bibFiles) {
      for (const entry of file.entries) {
        if (term) {
          const matchesKey = entry.key.value.toLowerCase().includes(term);
          const matchesTitle = (entry.title || '').toLowerCase().includes(term);
          const matchesAuthor = entry.authors
            .toDisplayString()
            .toLowerCase()
            .includes(term);
          const matchesYear = (entry.year || '').toLowerCase().includes(term);
          if (!matchesKey && !matchesTitle && !matchesAuthor && !matchesYear) {
            continue;
          }
        }
        allMatches.push(entry.toJSON(file.path));
      }
    }

    return {
      items: allMatches.slice(0, limit),
      total: allMatches.length,
    };
  }

  /**
   * Resolve DOI (via library/citation) or arXiv/ISBN identifier and append to project .bib file.
   */
  public async resolveIdentifier(
    projectId: string,
    dto: ResolveIdentifierDto,
    pageId?: string,
  ): Promise<BibMutationResponseDto> {
    const idVo = IdentifierVo.parse(dto.identifier);
    if (idVo.type === 'unknown') {
      throw new IdentifierNotFoundException(dto.identifier);
    }

    let resolvedEntry: BibEntry | null = null;
    if (idVo.type === 'doi' && this.doiNegotiation) {
      try {
        const bibtexResult = await this.doiNegotiation.resolveCitation(
          idVo.clean,
          'bibtex',
        );
        if (bibtexResult?.bibliography) {
          const parsed = this.bibParser.parse(bibtexResult.bibliography);
          if (parsed.length > 0) {
            resolvedEntry = parsed[0];
          }
        }
      } catch (err: unknown) {
        this.logger.warn(
          `Library DoiContentNegotiationService failed for ${idVo.clean}, falling back: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (!resolvedEntry) {
      resolvedEntry = await this.identifierResolver.resolve(idVo);
    }
    if (!resolvedEntry) {
      throw new IdentifierNotFoundException(dto.identifier);
    }

    const targetFile = dto.targetBibFile || 'references.bib';
    const result = await this.repository.appendEntriesToBib(
      projectId,
      [resolvedEntry],
      targetFile,
      pageId ?? dto.pageId,
    );

    return {
      filePath: result.filePath,
      docId: result.docId,
      entries: [resolvedEntry.toJSON(result.filePath)],
      conflicts: result.conflicts,
    };
  }

  /**
   * Sync reference collection from library / external provider into project .bib file.
   */
  public async syncLibraryCollection(
    projectId: string,
    userId: string,
    dto: SyncLibraryDto,
    pageId?: string,
  ): Promise<BibMutationResponseDto> {
    const rawBibtex = await this.repository.fetchCollectionBibtex(
      userId,
      dto.collectionId,
      projectId,
    );

    const entries = this.bibParser.parse(rawBibtex);
    const targetFile = dto.targetBibFile || 'references.bib';

    const result = await this.repository.appendEntriesToBib(
      projectId,
      entries,
      targetFile,
      pageId ?? dto.pageId,
    );

    if (result.conflicts.length > 0) {
      this.logger.warn(
        `[CitationSync] Detected ${result.conflicts.length} conflicting/overwritten citekeys in ${result.filePath}: ${result.conflicts.join(', ')}`,
      );
    }

    return {
      filePath: result.filePath,
      docId: result.docId,
      entries: entries.map((e) => e.toJSON(result.filePath)),
      conflicts: result.conflicts,
    };
  }

  /**
   * Format and upsert structured citation entries or raw BibTeX into the project's .bib file.
   */
  public async upsertEntries(
    projectId: string,
    dto: UpsertCitationEntriesDto,
    pageId?: string,
  ): Promise<BibMutationResponseDto> {
    const targetFile = dto.targetBibFile || 'references.bib';
    const domainEntries: BibEntry[] = [];

    if (dto.rawBibtex && dto.rawBibtex.trim()) {
      domainEntries.push(...this.bibParser.parse(dto.rawBibtex));
    }

    if (Array.isArray(dto.entries)) {
      for (const item of dto.entries) {
        domainEntries.push(buildBibEntryFromInput(item));
      }
    }

    if (domainEntries.length === 0) {
      throw new BadRequestException(
        'At least one entry or rawBibtex must be provided',
      );
    }

    const result = await this.repository.appendEntriesToBib(
      projectId,
      domainEntries,
      targetFile,
      pageId ?? dto.pageId,
    );

    return {
      filePath: result.filePath,
      docId: result.docId,
      entries: domainEntries.map((e) => e.toJSON(result.filePath)),
      conflicts: result.conflicts,
    };
  }
}
