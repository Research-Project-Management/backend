/**
 * citations/citations.service.ts
 * Deep Service orchestrating Citations, BibTeX, DOI/arXiv resolution & Library sync.
 */

import { Injectable, Optional, Logger, BadRequestException } from '@nestjs/common';
import { CitationsRepository } from './citations.repository';
import {
  IdentifierVo,
  BibEntry,
  IdentifierResolver,
  IIdentifierResolverPort,
  IdentifierNotFoundException,
  InvalidBibtexException,
  BibtexParser,
  validateCitationKey,
  buildBibEntryFromInput,
  buildBibliographySection,
  injectBibliographyIntoDocument,
  isLatexDocument,
  InjectBibliographyResult,
} from './domain';
import {
  CitationQueryDto,
  ResolveIdentifierDto,
  SyncLibraryDto,
  BibEntryDto,
  CitationValidationDto,
  SyncLibraryResultDto,
  RefactorCitationKeyDto,
  RefactorCitationKeyResultDto,
  UpsertCitationEntriesDto,
  UpsertCitationEntriesResultDto,
  InjectBibliographyDto,
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
  ) {
    this.bibParser = bibParser ?? new BibtexParser();
    this.identifierResolver =
      identifierResolver ?? new IdentifierResolver();
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
    const idVo = IdentifierVo.parse(dto.identifier);
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
      projectId,
    );

    const entries = this.bibParser.parse(rawBibtex);
    const targetFile =
      dto.targetFilename || dto.targetBibFile || 'references.bib';

    const syncResult = await this.repository.appendEntriesToBib(
      projectId,
      entries,
      targetFile,
    );

    const filePath =
      typeof syncResult === 'string' ? syncResult : syncResult?.filePath;
    const conflicts =
      Array.isArray((syncResult as { conflicts?: string[] })?.conflicts)
        ? (syncResult as { conflicts: string[] }).conflicts
        : [];

    if (conflicts.length > 0) {
      this.logger.warn(
        `[CitationSync] Detected ${conflicts.length} conflicting/overwritten citekeys in ${filePath}: ${conflicts.join(', ')}`,
      );
    }

    return {
      collectionId: dto.collectionId,
      syncedCount: entries.length,
      filePath,
      conflicts,
    };
  }

  /**
   * List available collections for user from external library.
   */
  public async listUserLibraryCollections(userId: string, projectId?: string) {
    return this.repository.listCollections(userId, projectId);
  }

  /**
   * Parse raw BibTeX text in memory.
   */
  public parseRawBibtex(rawText: string): BibEntryDto[] {
    const entries = this.bibParser.parse(rawText);
    return entries.map((e) => e.toJSON() as BibEntryDto);
  }

  /**
   * Virtual .bib Projection (Editor ↔ Library Bridge):
   * Streams aggregated project references directly without intermediate disk mutations.
   */
  public async getVirtualProjectBibtex(projectId: string): Promise<string> {
    const bibFiles = await this.repository.collectBibFiles(projectId);
    if (!bibFiles.length) {
      return '';
    }
    return bibFiles
      .flatMap((b) => b.entries.map((e) => e.toBibtexString()))
      .join('\n\n');
  }

  /**
   * Atomically refactor a citation key across all project .bib and .tex/.md files.
   */
  public async refactorCitationKey(
    projectId: string,
    dto: RefactorCitationKeyDto,
  ): Promise<RefactorCitationKeyResultDto> {
    const oldKey = (dto.oldKey || '').trim();
    const newKey = (dto.newKey || '').trim();
    const validation = validateCitationKey(newKey, oldKey);
    if (!validation.isValid) {
      throw new InvalidBibtexException(
        validation.error || 'Invalid citation key',
      );
    }

    const { affectedFiles, totalReplacements } =
      await this.repository.refactorCitationKey(projectId, oldKey, newKey);

    return {
      oldKey,
      newKey,
      totalReplacements,
      affectedFiles,
    };
  }

  /**
   * Format and upsert structured citation entries or raw BibTeX into the project's .bib file.
   */
  public async upsertEntries(
    projectId: string,
    dto: UpsertCitationEntriesDto,
  ): Promise<UpsertCitationEntriesResultDto> {
    const targetFile =
      dto.targetBibFile || dto.targetFilename || 'references.bib';
    const domainEntries: BibEntry[] = [];

    if (dto.rawBibtex && dto.rawBibtex.trim()) {
      const parsed = this.bibParser.parse(dto.rawBibtex);
      domainEntries.push(...parsed);
    }

    if (dto.entry) {
      domainEntries.push(buildBibEntryFromInput(dto.entry));
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

    const syncResult = await this.repository.appendEntriesToBib(
      projectId,
      domainEntries,
      targetFile,
    );

    const filePath =
      typeof syncResult === 'string' ? syncResult : syncResult?.filePath;
    const docId =
      typeof syncResult === 'object' ? syncResult?.docId : undefined;
    const conflicts = Array.isArray(syncResult?.conflicts)
      ? syncResult.conflicts
      : [];

    const formattedBibtex = domainEntries
      .map((e) => e.toBibtexString())
      .join('\n\n');

    return {
      filePath,
      docId,
      syncedCount: domainEntries.length,
      entries: domainEntries.map((e) => e.toJSON() as BibEntryDto),
      formattedBibtex,
      conflicts,
    };
  }

  /**
   * Build and inject a formatted bibliography section (\bibitem or Markdown ## References)
   * into a document, optionally persisting to DocstoreService when docId is provided.
   */
  public async injectBibliography(
    projectId: string | null,
    dto: InjectBibliographyDto,
  ): Promise<InjectBibliographyResult> {
    let currentContent = dto.content ?? '';
    let filePath = dto.filePath;

    if (projectId && dto.docId && !dto.content) {
      const docData = await this.repository.getDocContent(projectId, dto.docId);
      if (docData) {
        currentContent = docData.content;
        if (!filePath) filePath = docData.path;
      }
    }

    const format =
      dto.format ||
      (isLatexDocument(currentContent, filePath) ? 'latex' : 'markdown');

    const newSection = buildBibliographySection({
      bibliographyText: dto.bibliographyText,
      format,
      styleId: dto.styleId,
      headingTitle: dto.headingTitle,
      citations: dto.citations,
    });

    const result = injectBibliographyIntoDocument({
      currentContent,
      newSection,
      format,
    });

    if (projectId && dto.docId) {
      await this.repository
        .updateDocContent(projectId, dto.docId, result.nextContent)
        .catch((err: unknown) => {
          this.logger.warn(
            `Failed to persist injected bibliography to doc ${dto.docId}: ${(err as Error)?.message}`,
          );
        });
    }

    return result;
  }
}
