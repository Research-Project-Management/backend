import {
  Injectable,
  NotFoundException,
  Logger,
  Optional,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { ItemsRepository } from '../items/items.repository';
import { BibtexFormatter, BibtexSource } from './formatters/bibtex.formatter';
import { BibtexParser } from './parsers/bibtex.parser';
import { DoiResolver, ResolvedDoiMetadata } from './resolvers/doi.resolver';
import { ImportBibtexDto, FormatBatchCitationDto } from './dto/cite.dto';
import {
  CslFormatter,
  CitationStyle,
  FormattedCitation,
  CslSourcePaper,
} from './formatters/csl.formatter';
import { RisFormatter } from './formatters/ris.formatter';
import { MapperService, ReferenceManagerMapperService } from './mapper.service';

import { CslItem } from './types/cite.types';

import { RedisCacheService } from '@/core/cache/redis-cache.service';

export interface FullCitationProjection {
  itemId?: string;
  citationKey: string;
  apa: FormattedCitation;
  ieee: FormattedCitation;
  nature: FormattedCitation;
  chicago: FormattedCitation;
  mla: FormattedCitation;
  vancouver: FormattedCitation;
  bibtex: string;
  biblatex: string;
  ris: string;
  cslJson: CslItem;
  renderedAt: string;
}

@Injectable()
export class CiteService {
  private readonly logger = new Logger(CiteService.name);
  private readonly memoryCache = new Map<
    string,
    { value: any; expiresAt: number }
  >();
  private readonly CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
  private readonly REDIS_KEY_PREFIX = 'citation:projection:';

  constructor(
    private readonly catalogRepo: ItemsRepository,
    private readonly bibtexFormatter: BibtexFormatter,
    private readonly bibtexParser: BibtexParser,
    private readonly doiResolver: DoiResolver,
    private readonly cslFormatter: CslFormatter,
    private readonly risFormatter: RisFormatter,
    private readonly refMapper: ReferenceManagerMapperService,
    @Optional() private readonly redisCache?: RedisCacheService,
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
    authors: string[],
    year?: number | null,
  ): string {
    return this.bibtexFormatter.generateCitationKey(title, authors, year);
  }

  /**
   * Exports item metadata into BibTeX string
   */
  async exportBibtex(workspaceId: string, itemId: string) {
    const targetWsId = await this.catalogRepo.resolveWorkspaceId(workspaceId);

    const item = await this.catalogRepo.findItemByIdInWorkspace(
      targetWsId,
      itemId,
    );
    if (!item || item.deletedAt) {
      throw new NotFoundException('Catalog item not found in this workspace');
    }

    return {
      bibtex: this.bibtexFormatter.formatEntry(item),
      citationKey: item.citationKey,
      filename: `${item.citationKey || 'citation'}.bib`,
    };
  }

  /**
   * Exports entire workspace or collection as single bulk BibTeX file
   */
  async exportWorkspaceBibtex(
    workspaceId: string,
    collectionId?: string,
  ): Promise<{
    bibtex: string;
    count: number;
    total: number;
    filename: string;
  }> {
    const targetWsId = await this.catalogRepo.resolveWorkspaceId(workspaceId);

    const items = await this.catalogRepo.findItems(
      {
        workspaceId: targetWsId,
        ...(collectionId ? { collectionId } : {}),
        deletedAt: null,
      },
      { orderBy: [{ createdAt: 'desc' }] },
    );

    const bibtex = items
      .map((item) => this.bibtexFormatter.formatEntry(item))
      .join('\n\n');

    return {
      bibtex,
      count: items.length,
      total: items.length,
      filename: collectionId
        ? `collection-${collectionId}.bib`
        : `workspace-${targetWsId}.bib`,
    };
  }

  /**
   * Generates complete collection export bundle (BibTeX string + files manifest)
   */
  async getCollectionExportBundle(workspaceId: string, collectionId: string) {
    const targetWsId = await this.catalogRepo.resolveWorkspaceId(workspaceId);
    const items = await this.catalogRepo.findItems(
      {
        workspaceId: targetWsId,
        collectionId,
        deletedAt: null,
      },
      { orderBy: [{ createdAt: 'desc' }] },
    );

    const bibtex = items
      .map((item) => this.bibtexFormatter.formatEntry(item))
      .join('\n\n');

    const files = items.flatMap((item) =>
      (item.attachments || []).map((att: any) => ({
        id: att.id,

        itemId: item.id,
        filename: att.filename,
        fileUrl: att.url,
        url: att.url,
        mimeType: att.mimeType,
        size: att.size,
      })),
    );

    return {
      workspaceId: targetWsId,
      collectionId,
      totalItems: items.length,
      totalFiles: files.length,
      bibtex,
      filename: `collection-${collectionId}.bib`,
      files,
      exportedAt: new Date().toISOString(),
    };
  }

  /**
   * Parses raw BibTeX text without persisting
   */
  parseBibtex(bibtex: string) {
    const entries = this.bibtexParser.parse(bibtex);
    return {
      total: entries.length,
      entries,
    };
  }

  /**
   * Imports raw BibTeX content and creates catalog items
   */
  async importBibtex(
    workspaceId: string,
    userId: string,
    dto: ImportBibtexDto,
  ) {
    const targetWsId = await this.catalogRepo.resolveWorkspaceId(workspaceId);
    const parsedEntries = this.bibtexParser.parse(dto.bibtex);
    if (!parsedEntries || parsedEntries.length === 0) {
      throw new NotFoundException('No valid BibTeX entries found in payload');
    }

    const createdItems = [];
    for (const entry of parsedEntries) {
      const citationKey = await this.catalogRepo.resolveUniqueCitationKey(
        targetWsId,
        entry.citationKey ||
          this.bibtexFormatter.generateCitationKey(
            entry.title,
            entry.authors || [],
            entry.year,
          ),
      );

      const paper = await this.catalogRepo.createItem({
        workspace: { connect: { id: targetWsId } },
        uploadedBy: { connect: { id: userId } },
        title: entry.title,
        filename: entry.title
          ? `${entry.title.slice(0, 50)}.bib`
          : 'citation.bib',
        fileUrl: '',
        authors: entry.authors || [],
        year: entry.year || null,
        doi: entry.doi || null,
        publicationTitle: entry.journal || entry.publisher || null,
        volume: entry.volume || null,
        issue: entry.issue || null,
        pages: entry.pages || null,
        abstract: entry.abstract || null,
        itemType: entry.itemType || 'journalArticle',
        isbn: entry.isbn || null,
        issn: entry.issn || null,
        url: entry.url || null,
        citationKey,
        ...(dto.collectionId && {
          collection: { connect: { id: dto.collectionId } },
        }),
      });
      createdItems.push(paper);
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
    const targetWsId = await this.catalogRepo.resolveWorkspaceId(workspaceId);
    const entries = this.risFormatter.parse(dto.content);
    if (!entries || entries.length === 0) {
      throw new NotFoundException('No valid RIS records found in content');
    }

    const createdItems = [];
    for (const entry of entries) {
      const citationKey = await this.catalogRepo.resolveUniqueCitationKey(
        targetWsId,
        this.bibtexFormatter.generateCitationKey(
          entry.title || 'item',
          entry.authors || [],
          entry.year,
        ),
      );

      const paper = await this.catalogRepo.createItem({
        workspace: { connect: { id: targetWsId } },
        uploadedBy: { connect: { id: userId } },
        title: entry.title || 'Untitled Reference',
        filename: entry.title
          ? `${entry.title.slice(0, 50)}.ris`
          : 'reference.ris',
        fileUrl: '',
        authors: entry.authors || [],
        year: entry.year || null,
        doi: entry.doi || null,
        publicationTitle: entry.journal || entry.publisher || null,
        volume: entry.volume || null,
        issue: entry.issue || null,
        pages: entry.pages || null,
        abstract: entry.abstract || null,
        itemType: entry.itemType || 'journalArticle',
        url: entry.url || null,
        citationKey,
        ...(dto.collectionId && {
          collection: { connect: { id: dto.collectionId } },
        }),
      });
      createdItems.push(paper);
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

  /**
   * Generates a deterministic MD5 fingerprint for a cacheable citation render
   */
  private generateCacheKey(
    itemId: string,
    version: number | string,
    style: string,
  ): string {
    const raw = `${itemId}:${version}:${style}`;
    return createHash('md5').update(raw).digest('hex');
  }

  /**
   * Renders citation for a single item in specified style with hash-based caching
   */
  async projectCitation(
    item: CslSourcePaper & { version?: number; updatedAt?: Date | string },
    style: CitationStyle = 'apa',
  ): Promise<FormattedCitation> {
    const itemId = item.id || item.citationKey || item.title;
    const version =
      item.version || (item.updatedAt ? String(item.updatedAt) : '1');
    const cacheKey = this.generateCacheKey(itemId, version, style);

    // 1. Check Memory Cache
    const memCached = this.memoryCache.get(cacheKey);
    if (memCached && memCached.expiresAt > Date.now()) {
      return memCached.value;
    }

    // 2. Check Redis Cache
    if (this.redisCache?.isReady()) {
      const redisCached = await this.redisCache.get<FormattedCitation>(
        `${this.REDIS_KEY_PREFIX}${cacheKey}`,
      );
      if (redisCached) {
        this.memoryCache.set(cacheKey, {
          value: redisCached,
          expiresAt: Date.now() + this.CACHE_TTL_MS,
        });
        return redisCached;
      }
    }

    // 3. Render citation
    const rendered = this.cslFormatter.formatEntry(item, style);

    // 4. Save to caches
    this.memoryCache.set(cacheKey, {
      value: rendered,
      expiresAt: Date.now() + this.CACHE_TTL_MS,
    });

    if (this.redisCache?.isReady()) {
      await this.redisCache.set(
        `${this.REDIS_KEY_PREFIX}${cacheKey}`,
        rendered,
        86400,
      );
    }

    return rendered;
  }

  /**
   * Generates BibTeX export string for single or multiple items
   */
  projectBibtex(items: CslSourcePaper | CslSourcePaper[]): string {
    const list = Array.isArray(items) ? items : [items];
    return list
      .map((item) => this.bibtexFormatter.formatEntry(item as any))
      .join('\n\n');
  }

  /**
   * Generates BibLaTeX export string with extended eprint/arxiv and online fields
   */
  projectBiblatex(items: CslSourcePaper | CslSourcePaper[]): string {
    const list = Array.isArray(items) ? items : [items];
    return list
      .map((item) => {
        let bib = this.bibtexFormatter.formatEntry(item);
        if (item.extra?.includes('arXiv:')) {
          const match = item.extra.match(/arXiv:\s*([^\s\n]+)/i);
          if (match) {
            bib = bib.replace(
              /\}\s*$/,
              `,\n  eprint = {${match[1]}},\n  eprinttype = {arXiv}\n}`,
            );
          }
        }
        return bib;
      })
      .join('\n\n');
  }

  /**
   * Generates standard RIS format for single or multiple items
   */
  projectRis(items: CslSourcePaper | CslSourcePaper[]): string {
    const list = Array.isArray(items) ? items : [items];
    return list.map((item) => this.risFormatter.formatEntry(item)).join('\n\n');
  }

  /**
   * Generates standard CSL JSON format for single or multiple items
   */
  projectCslJson(
    items: CslSourcePaper | CslSourcePaper[],
  ): CslItem | CslItem[] {
    if (Array.isArray(items)) {
      return items.map((item) => this.refMapper.toCslJson(item as any));
    }
    return this.refMapper.toCslJson(items as any);
  }

  /**
   * Projects all citation styles and standard export representations in a single call
   */
  async projectAllStyles(
    item: CslSourcePaper & { version?: number; updatedAt?: Date | string },
  ): Promise<FullCitationProjection> {
    const [apa, ieee, nature, chicago, mla, vancouver] = await Promise.all([
      this.projectCitation(item, 'apa'),
      this.projectCitation(item, 'ieee'),
      this.projectCitation(item, 'nature'),
      this.projectCitation(item, 'chicago'),
      this.projectCitation(item, 'mla'),
      this.projectCitation(item, 'vancouver'),
    ]);

    const bibtex = this.projectBibtex(item);
    const biblatex = this.projectBiblatex(item);
    const ris = this.projectRis(item);
    const cslJson = this.projectCslJson(item) as CslItem;

    return {
      itemId: item.id,
      citationKey: item.citationKey || cslJson.id,
      apa,
      ieee,
      nature,
      chicago,
      mla,
      vancouver,
      bibtex,
      biblatex,
      ris,
      cslJson,
      renderedAt: new Date().toISOString(),
    };
  }

  /**
   * Helper for tests: clears local in-memory cache
   */
  clearCacheForTesting() {
    this.memoryCache.clear();
  }
}

export {
  CiteService as CitationService,
  CiteService as CiteProjectionService,
  CiteService as CitationProjectionService,
};
