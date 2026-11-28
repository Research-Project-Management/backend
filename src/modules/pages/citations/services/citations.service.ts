/**
 * citations/citations.service.ts
 * Service orchestrating page-scoped .bib citations, DOI/arXiv resolution, and Library sync.
 */

import {
  Injectable,
  Optional,
  Logger,
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { CitationsRepository } from '../repositories/citations.repository';
import { CitationIndexService } from './index.service';
import { LibrarySyncAdapter } from './sync.service';
import { DoiContentNegotiationService } from '@/modules/library/citation/services/doi-negotiation.service';
import { QueryResolverService } from '@/modules/library/citation/services/query-resolver.service';
import { IdentifierVo } from '../domain/value-objects.domain';
import {
  BibEntry,
  buildBibEntryFromInput,
  matchesCitationQuery,
} from '../domain/bib-entry.domain';
import { IdentifierNotFoundException } from '../domain/citations.errors';
import { BibtexParser } from '../domain/bibtex.domain';
import {
  CitationQueryDto,
  ResolveIdentifierDto,
  SyncLibraryDto,
  CitationEntryDto,
  ListCitationsResponseDto,
  BibMutationResponseDto,
  UpsertCitationEntriesDto,
} from '../dto/citations.dto';

@Injectable()
export class CitationsService {
  private readonly logger = new Logger(CitationsService.name);
  private readonly bibParser: BibtexParser;

  constructor(
    private readonly repository: CitationsRepository,
    @Optional() bibParser?: BibtexParser,
    @Optional()
    private readonly doiNegotiation?: DoiContentNegotiationService,
    @Optional()
    private readonly queryResolver?: QueryResolverService,
    @Optional()
    private readonly citationIndex?: CitationIndexService,
    @Optional()
    private readonly librarySync?: LibrarySyncAdapter,
  ) {
    this.bibParser = bibParser ?? new BibtexParser();
  }

  private resolveTargetPageId(
    explicitPageId?: string,
    dtoPageId?: string,
  ): string | undefined {
    return (explicitPageId || dtoPageId)?.trim() || undefined;
  }

  /**
   * List or search citation entries across .bib files in the page (or space when unscoped).
   * Uses CQRS L1/L2 cached CitationIndexService when available.
   */
  public async listCitations(
    spaceId: string,
    queryDto: CitationQueryDto,
    pageId?: string,
  ): Promise<ListCitationsResponseDto> {
    const resolvedPageId = this.resolveTargetPageId(pageId, queryDto?.pageId);
    const limit = queryDto?.limit ?? 500;

    if (this.citationIndex) {
      return this.citationIndex.queryCitations(
        spaceId,
        queryDto?.query,
        limit,
        resolvedPageId,
      );
    }

    const bibFiles = await this.repository.collectBibFiles(
      spaceId,
      resolvedPageId,
    );

    const allMatches: CitationEntryDto[] = [];
    for (const file of bibFiles) {
      for (const entry of file.entries) {
        const dto = entry.toJSON(file.path);
        if (matchesCitationQuery(dto, queryDto?.query)) {
          allMatches.push(dto);
        }
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
    spaceId: string,
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

    if (!resolvedEntry && this.queryResolver) {
      try {
        const refData = await this.queryResolver.resolveAcademicQuery(
          idVo.clean,
        );
        if (refData?.found && refData.work) {
          const work = refData.work;
          resolvedEntry = buildBibEntryFromInput({
            title: work.title,
            authors: work.authors,
            year: work.year,
            journal: work.journal,
            publisher: work.publisher,
            volume: work.volume,
            issue: work.issue,
            pages: work.pages,
            doi: work.doi,
            url: work.url,
            type: work.type,
          });
        }
      } catch (err: unknown) {
        this.logger.warn(
          `Library QueryResolverService failed for ${idVo.clean}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (!resolvedEntry) {
      throw new IdentifierNotFoundException(dto.identifier);
    }

    const resolvedPageId = this.resolveTargetPageId(pageId, dto.pageId);
    const targetFile = dto.targetBibFile || 'references.bib';
    const result = await this.repository.appendEntriesToBib(
      spaceId,
      [resolvedEntry],
      targetFile,
      resolvedPageId,
    );
    await this.citationIndex?.invalidateSpace(spaceId, resolvedPageId);

    return {
      filePath: result.filePath,
      docId: result.docId,
      entries: [resolvedEntry.toJSON(result.filePath)],
      conflicts: result.conflicts,
    };
  }

  /**
   * Sync reference collection from library / external provider into page .bib file.
   */
  public async syncLibraryCollection(
    spaceId: string,
    userId: string,
    dto: SyncLibraryDto,
    pageId?: string,
  ): Promise<BibMutationResponseDto> {
    if (!this.librarySync) {
      throw new ServiceUnavailableException(
        'Library citation sync service is not configured',
      );
    }

    const resolvedPageId = this.resolveTargetPageId(pageId, dto.pageId);
    const rawBibtex = await this.librarySync.fetchCollectionBibtex(
      userId,
      dto.collectionId,
      spaceId,
    );

    const entries = this.bibParser.parse(rawBibtex);
    const targetFile = dto.targetBibFile || 'references.bib';

    const result = await this.repository.appendEntriesToBib(
      spaceId,
      entries,
      targetFile,
      resolvedPageId,
      dto.conflictPolicy ?? 'overwrite',
    );
    await this.citationIndex?.invalidateSpace(spaceId, resolvedPageId);

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
   * Format and upsert structured citation entries or raw BibTeX into the page's .bib file.
   */
  public async upsertEntries(
    spaceId: string,
    dto: UpsertCitationEntriesDto,
    pageId?: string,
  ): Promise<BibMutationResponseDto> {
    const resolvedPageId = this.resolveTargetPageId(pageId, dto.pageId);
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
      spaceId,
      domainEntries,
      targetFile,
      resolvedPageId,
      dto.conflictPolicy ?? 'overwrite',
    );
    await this.citationIndex?.invalidateSpace(spaceId, resolvedPageId);

    return {
      filePath: result.filePath,
      docId: result.docId,
      entries: domainEntries.map((e) => e.toJSON(result.filePath)),
      conflicts: result.conflicts,
    };
  }
}
