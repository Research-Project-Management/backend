import {
  Injectable,
  NotFoundException,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { CatalogRepository } from '../catalog/catalog.repository';
import { BibtexFormatter, BibtexSource } from './formatters/bibtex.formatter';
import { BibtexParser } from './parsers/bibtex.parser';
import { DoiResolver, ResolvedDoiMetadata } from './resolvers/doi.resolver';
import { ImportBibtexDto, FormatBatchCitationDto } from './dto/citation.dto';
import {
  CslFormatter,
  CitationStyle,
  FormattedCitation,
} from './formatters/csl.formatter';
import { RisFormatter } from './formatters/ris.formatter';
import { IngestionService } from '../ingestion/ingestion.service';
import { IngestionSourceType } from '../ingestion/dto/ingestion.dto';

@Injectable()
export class CitationService {
  constructor(
    @Inject(forwardRef(() => CatalogRepository))
    private readonly catalogRepo: CatalogRepository,
    private readonly bibtexFormatter: BibtexFormatter,
    private readonly bibtexParser: BibtexParser,
    private readonly doiResolver: DoiResolver,
    private readonly cslFormatter: CslFormatter,
    private readonly risFormatter: RisFormatter,
    @Inject(forwardRef(() => IngestionService))
    private readonly ingestionService: IngestionService,
  ) {}

  /**
   * Formats a single catalog item into specified citation style
   */
  async formatCitation(
    workspaceId: string,
    itemId: string,
    style: string = 'apa',
  ): Promise<FormattedCitation> {
    const targetWsId = await this.catalogRepo.resolveWorkspaceId(workspaceId);

    const item = await this.catalogRepo.findItemByIdInWorkspace(
      targetWsId,
      itemId,
    );
    if (!item || item.deletedAt) {
      throw new NotFoundException('Catalog item not found in this workspace');
    }

    return this.cslFormatter.formatEntry(item, style as CitationStyle);
  }

  /**
   * Formats a batch of catalog items into specified citation style
   */
  async formatBatchCitations(workspaceId: string, dto: FormatBatchCitationDto) {
    const targetWsId = await this.catalogRepo.resolveWorkspaceId(workspaceId);
    const style = (dto.style || 'apa') as CitationStyle;
    const requestedIds = dto.itemIds || dto.paperIds || [];

    const items = await this.catalogRepo.findItems({
      id: { in: requestedIds },
      workspaceId: targetWsId,
      deletedAt: null,
    });

    if (items.length !== requestedIds.length) {
      throw new NotFoundException(
        'One or more catalog items were not found in this workspace',
      );
    }

    const entries = items.map((item, idx) =>
      this.cslFormatter.formatEntry(item, style, idx + 1),
    );

    return {
      style,
      total: entries.length,
      entries,
    };
  }

  /**
   * Resolves academic metadata from a DOI string
   */
  async resolveDoi(doi: string): Promise<ResolvedDoiMetadata> {
    const metadata = await this.doiResolver.resolve(doi);
    if (!metadata) {
      throw new NotFoundException(`Could not resolve metadata for DOI: ${doi}`);
    }
    return metadata;
  }

  /**
   * Exports a single item or list of items to a formatted BibTeX string
   */
  formatBibtex(itemOrItems: BibtexSource | BibtexSource[]): string {
    if (Array.isArray(itemOrItems)) {
      return this.bibtexFormatter.formatMultiple(itemOrItems);
    }
    return this.bibtexFormatter.formatEntry(itemOrItems);
  }

  /**
   * Generates a citation key for any item metadata
   */
  generateCitationKey(
    title: string,
    authors: string[] = [],
    year?: number | null,
  ): string {
    return this.bibtexFormatter.generateCitationKey(title, authors, year);
  }

  /**
   * Exports all items of a workspace or collection as a complete .bib file
   */
  async exportWorkspaceBibtex(
    workspaceId: string,
    collectionId?: string,
  ): Promise<{ bibtex: string; total: number; filename: string }> {
    const targetWsId = await this.catalogRepo.resolveWorkspaceId(workspaceId);

    const where = {
      workspaceId: targetWsId,
      deletedAt: null,
      ...(collectionId && { collectionId }),
    };

    const items = await this.catalogRepo.findItems(where, {
      orderBy: [{ createdAt: 'desc' }],
    });

    const bibtex = this.bibtexFormatter.formatMultiple(items);
    const filename = collectionId
      ? `collection-${collectionId}.bib`
      : `workspace-${workspaceId}.bib`;

    return {
      bibtex,
      total: items.length,
      filename,
    };
  }

  /**
   * Bulk import raw BibTeX text string into workspace library
   */
  async importBibtex(
    workspaceId: string,
    userId: string,
    dto: ImportBibtexDto,
  ) {
    const parsedEntries = this.bibtexParser.parse(dto.bibtex);
    if (!parsedEntries || parsedEntries.length === 0) {
      return { imported: 0, items: [] };
    }

    const createdItems = [];
    for (const entry of parsedEntries) {
      const res = await this.ingestionService.ingest(userId, {
        workspaceId,
        sourceType: IngestionSourceType.BIBTEX,
        title: entry.title,
        authors: entry.authors || [],
        year: entry.year || null,
        doi: entry.doi || '',
        journal: entry.journal || '',
        publisher: entry.publisher || '',
        volume: entry.volume || '',
        issue: entry.issue || '',
        pages: entry.pages || '',
        abstract: entry.abstract || '',
        itemType: entry.itemType || 'journalArticle',
        isbn: entry.isbn || '',
        issn: entry.issn || '',
        url: entry.url || '',
        citationKey: entry.citationKey,
        collectionId: dto.collectionId || null,
      });
      if (res.paper) createdItems.push(res.paper);
    }

    return {
      imported: createdItems.length,
      items: createdItems,
    };
  }

  /**
   * Parses raw RIS text without persisting
   */
  parseRis(content: string) {
    const entries = this.risFormatter.parse(content);
    return {
      total: entries.length,
      entries,
    };
  }

  /**
   * Imports RIS text and creates catalog items
   */
  async importRis(
    workspaceId: string,
    userId: string,
    dto: { content: string; collectionId?: string },
  ) {
    const entries = this.risFormatter.parse(dto.content);
    if (!entries || entries.length === 0) {
      throw new NotFoundException('No valid RIS records found in content');
    }

    const createdItems = [];
    for (const entry of entries) {
      const res = await this.ingestionService.ingest(userId, {
        workspaceId,
        sourceType: IngestionSourceType.RIS,
        title: entry.title,
        authors: entry.authors || [],
        year: entry.year || null,
        doi: entry.doi || '',
        journal: entry.journal || '',
        publisher: entry.publisher || '',
        volume: entry.volume || '',
        issue: entry.issue || '',
        pages: entry.pages || '',
        abstract: entry.abstract || '',
        itemType: entry.itemType || 'journalArticle',
        url: entry.url || '',
        collectionId: dto.collectionId || null,
      });
      if (res.paper) createdItems.push(res.paper);
    }

    return {
      imported: createdItems.length,
      items: createdItems,
    };
  }

  /**
   * Exports item metadata into RIS string
   */
  async exportRis(workspaceId: string, itemId: string) {
    const targetWsId = await this.catalogRepo.resolveWorkspaceId(workspaceId);

    const item = await this.catalogRepo.findItemByIdInWorkspace(
      targetWsId,
      itemId,
    );
    if (!item || item.deletedAt) {
      throw new NotFoundException('Catalog item not found');
    }

    return {
      ris: this.risFormatter.formatEntry(item),
      filename: `${item.citationKey || 'item'}.ris`,
    };
  }
}
