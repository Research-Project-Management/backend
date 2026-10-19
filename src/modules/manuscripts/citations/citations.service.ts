/**
 * citations/citations.service.ts
 * Deep Service orchestrating Citations, BibTeX, DOI/arXiv resolution & Library sync.
 */

import { Injectable, Optional } from '@nestjs/common';
import { CitationsRepository } from './citations.repository';
import {
  AcademicIdentifierVo,
  BibEntry,
  CrossrefArxivResolverAdapter,
  IIdentifierResolverPort,
  IdentifierNotFoundException,
  RegexAstBibtexParser,
} from './domain';
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
  private readonly bibParser: RegexAstBibtexParser;
  private readonly identifierResolver: IIdentifierResolverPort;

  constructor(
    private readonly repository: CitationsRepository,
    @Optional() bibParser?: RegexAstBibtexParser,
    @Optional() identifierResolver?: CrossrefArxivResolverAdapter,
  ) {
    this.bibParser = bibParser ?? new RegexAstBibtexParser();
    this.identifierResolver =
      identifierResolver ?? new CrossrefArxivResolverAdapter();
  }

  /**
   * Search citation keys in the project to power \cite{...} autocomplete.
   */
  public async searchCitationKeys(
    projectId: string,
    queryDto: CitationQueryDto,
  ): Promise<BibEntryDto[]> {
    const bibFiles = await this.repository.collectBibFiles(projectId);
    const limit = queryDto.limit && queryDto.limit > 0 ? queryDto.limit : 50;

    const allMatches: BibEntry[] = [];
    const seenKeys = new Set<string>();

    for (const file of bibFiles) {
      const matches = file.findMatches(queryDto.query);
      for (const m of matches) {
        const lowerKey = m.key.value.toLowerCase();
        if (!seenKeys.has(lowerKey)) {
          seenKeys.add(lowerKey);
          allMatches.push(m);
        }
        if (allMatches.length >= limit) {
          break;
        }
      }
      if (allMatches.length >= limit) {
        break;
      }
    }

    return allMatches.map((e) => e.toJSON() as BibEntryDto);
  }

  /**
   * Resolve DOI or arXiv identifier and append to project .bib file.
   */
  public async resolveIdentifier(
    projectId: string,
    dto: ResolveIdentifierDto,
  ): Promise<{ entry: BibEntryDto; filePath: string; identifierType: string }> {
    const idVo = AcademicIdentifierVo.parse(dto.identifier);
    if (idVo.type === 'unknown') {
      throw new IdentifierNotFoundException(dto.identifier);
    }

    const resolvedEntry = await this.identifierResolver.resolve(idVo);
    if (!resolvedEntry) {
      throw new IdentifierNotFoundException(dto.identifier);
    }

    const targetFile = dto.targetBibFile || 'references.bib';
    const filePath = await this.repository.appendEntryToBib(
      projectId,
      resolvedEntry,
      targetFile,
    );

    return {
      entry: resolvedEntry.toJSON(),
      filePath,
      identifierType: idVo.type,
    };
  }

  /**
   * Validate all .bib files in project for duplicates or syntax issues.
   */
  public async validateProjectBibtex(
    projectId: string,
  ): Promise<CitationValidationDto> {
    const bibFiles = await this.repository.collectBibFiles(projectId);

    const allKeysMap = new Map<string, string[]>();
    const warnings: string[] = [];
    const missingFieldWarnings: Array<{
      key: string;
      missingFields: string[];
    }> = [];
    let totalEntries = 0;

    for (const file of bibFiles) {
      totalEntries += file.totalCount;

      for (const entry of file.entries) {
        const k = entry.key.value;
        const existing = allKeysMap.get(k) || [];
        existing.push(file.path);
        allKeysMap.set(k, existing);

        const missingFields: string[] = [];
        if (!entry.title) {
          warnings.push(`Entry '${k}' in ${file.path} is missing a title.`);
          missingFields.push('title');
        }
        if (!entry.authors.authors.length) {
          warnings.push(`Entry '${k}' in ${file.path} is missing an author.`);
          missingFields.push('author');
        }
        if (!entry.year) {
          warnings.push(
            `Entry '${k}' in ${file.path} is missing a publication year.`,
          );
          missingFields.push('year');
        }
        if (missingFields.length > 0) {
          missingFieldWarnings.push({ key: k, missingFields });
        }
      }
    }

    const duplicateKeys: string[] = [];
    for (const [k, files] of allKeysMap.entries()) {
      if (files.length > 1) {
        duplicateKeys.push(k);
        warnings.push(
          `Duplicate citation key '${k}' appears ${files.length} times in: ${files.join(', ')}`,
        );
      }
    }

    const isValid = duplicateKeys.length === 0;

    return {
      valid: isValid,
      isValid,
      totalFiles: bibFiles.length,
      totalEntries,
      duplicateKeys,
      warnings,
      missingFieldWarnings,
    };
  }

  /**
   * Sync reference collection from external library (Zotero / Flux Library).
   */
  public async syncLibraryCollection(
    projectId: string,
    userId: string,
    dto: SyncLibraryDto,
  ): Promise<SyncLibraryResultDto> {
    const rawBibtex = await this.repository.fetchCollectionBibtex(
      userId,
      dto.collectionId,
    );

    const entries = this.bibParser.parse(rawBibtex);
    const targetFile =
      dto.targetFilename || dto.targetBibFile || 'references.bib';

    const lastPath = await this.repository.appendEntriesToBib(
      projectId,
      entries,
      targetFile,
    );

    return {
      collectionId: dto.collectionId,
      syncedCount: entries.length,
      filePath: lastPath,
    };
  }

  /**
   * List available collections for user from external library.
   */
  public async listUserLibraryCollections(userId: string) {
    return this.repository.listCollections(userId);
  }

  /**
   * Parse raw BibTeX text in memory.
   */
  public parseRawBibtex(rawText: string): BibEntryDto[] {
    const entries = this.bibParser.parse(rawText);
    return entries.map((e) => e.toJSON() as BibEntryDto);
  }
}
