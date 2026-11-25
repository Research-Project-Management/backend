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
import { CitationsRepository } from '../repositories/citations.repository';
import { CitationIndexService } from './index.service';
import { DoiContentNegotiationService } from '@/modules/library/citation/services/doi-negotiation.service';
import { IdentifierVo } from '../domain/value-objects.domain';
import { BibEntry, buildBibEntryFromInput } from '../domain/bib-entry.domain';
import {
  IdentifierResolver,
  ResilientIdentifierResolver,
} from './resolver.service';
import { IIdentifierResolverPort } from '../domain/citations.ports';
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
  private readonly identifierResolver: IIdentifierResolverPort;

  constructor(
    private readonly repository: CitationsRepository,
    @Optional() bibParser?: BibtexParser,
    @Optional() identifierResolver?: ResilientIdentifierResolver,
    @Optional()
    private readonly doiNegotiation?: DoiContentNegotiationService,
    @Optional()
    private readonly citationIndex?: CitationIndexService,
  ) {
    this.bibParser = bibParser ?? new BibtexParser();
    this.identifierResolver =
      identifierResolver ?? new ResilientIdentifierResolver(new IdentifierResolver());
  }

  /**
   * List or search citation entries across all .bib files in the project.
   * Uses CQRS L1/L2 cached CitationIndexService when available.
   */
  public async listCitations(
    spaceId: string,
    queryDto: CitationQueryDto,
    pageId?: string,
  ): Promise<ListCitationsResponseDto> {
    const resolvedPageId = pageId ?? queryDto.pageId;
    const limit = queryDto.limit ?? 500;

    if (this.citationIndex) {
      return this.citationIndex.queryCitations(
        spaceId,
        queryDto.query,
        limit,
        resolvedPageId,
      );
    }

    const bibFiles = await this.repository.collectBibFiles(
      spaceId,
      resolvedPageId,
    );
    const term = (queryDto.query || '').trim().toLowerCase();

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

    if (!resolvedEntry) {
      resolvedEntry = await this.identifierResolver.resolve(idVo);
    }
    if (!resolvedEntry) {
      throw new IdentifierNotFoundException(dto.identifier);
    }

    const targetFile = dto.targetBibFile || 'references.bib';
    const result = await this.repository.appendEntriesToBib(
      spaceId,
      [resolvedEntry],
      targetFile,
      pageId ?? dto.pageId,
    );
    await this.citationIndex?.invalidateSpace(spaceId, pageId ?? dto.pageId);

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
    spaceId: string,
    userId: string,
    dto: SyncLibraryDto,
    pageId?: string,
  ): Promise<BibMutationResponseDto> {
    const rawBibtex = await this.repository.fetchCollectionBibtex(
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
      pageId ?? dto.pageId,
      dto.conflictPolicy ?? 'overwrite',
    );
    await this.citationIndex?.invalidateSpace(spaceId, pageId ?? dto.pageId);

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
    spaceId: string,
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
      spaceId,
      domainEntries,
      targetFile,
      pageId ?? dto.pageId,
      dto.conflictPolicy ?? 'overwrite',
    );
    await this.citationIndex?.invalidateSpace(spaceId, pageId ?? dto.pageId);

    return {
      filePath: result.filePath,
      docId: result.docId,
      entries: domainEntries.map((e) => e.toJSON(result.filePath)),
      conflicts: result.conflicts,
    };
  }
}
