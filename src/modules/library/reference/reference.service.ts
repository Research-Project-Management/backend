import { Injectable, NotFoundException } from '@nestjs/common';
import { PaperRepository } from '../paper/paper.repository';
import { BibtexFormatter, BibtexSource } from './formatters/bibtex.formatter';
import { BibtexParser, ParsedBibtexEntry } from './parsers/bibtex.parser';
import { DoiResolver, ResolvedDoiMetadata } from './resolvers/doi.resolver';
import { CreateReferenceDto, ImportBibtexDto, FormatBatchCitationDto } from './dto/reference.dto';
import { UnifiedFetcherService, ResolveResult } from './fetchers/unified-fetcher.service';
import { CslFormatter, CitationStyle, FormattedCitation } from './formatters/csl.formatter';
import { RisFormatter } from './formatters/ris.formatter';

@Injectable()
export class ReferenceService {
  constructor(
    private readonly paperRepo: PaperRepository,
    private readonly bibtexFormatter: BibtexFormatter,
    private readonly bibtexParser: BibtexParser,
    private readonly doiResolver: DoiResolver,
    private readonly unifiedFetcher: UnifiedFetcherService,
    private readonly cslFormatter: CslFormatter,
    private readonly risFormatter: RisFormatter,
  ) {}

  /**
   * Formats a single paper into specified citation style
   */
  async formatPaperCitation(
    workspaceId: string,
    paperId: string,
    style: string = 'apa',
  ): Promise<FormattedCitation> {
    const ws = await this.paperRepo.resolveWorkspace(workspaceId);
    const targetWsId = ws?.id || workspaceId;

    const paper = await this.paperRepo.findPaperById(paperId);
    if (!paper || paper.deletedAt || paper.workspaceId !== targetWsId) {
      throw new NotFoundException('Paper not found in this workspace');
    }

    return this.cslFormatter.formatEntry(paper, style as CitationStyle);
  }

  /**
   * Formats a batch of papers into specified citation style
   */
  async formatBatchCitations(
    workspaceId: string,
    dto: FormatBatchCitationDto,
  ) {
    const ws = await this.paperRepo.resolveWorkspace(workspaceId);
    const targetWsId = ws?.id || workspaceId;
    const style = (dto.style || 'apa') as CitationStyle;

    const papers = await this.paperRepo.findPapers({
      id: { in: dto.paperIds },
      workspaceId: targetWsId,
      deletedAt: null,
    });

    const entries = papers.map((p, idx) =>
      this.cslFormatter.formatEntry(p, style, idx + 1),
    );

    return {
      style,
      total: entries.length,
      entries,
    };
  }

  /**
   * Resolves academic metadata from any query (DOI, arXiv, URL, or Title)
   */
  async resolve(query: string): Promise<ResolveResult> {
    const result = await this.unifiedFetcher.resolve(query);
    if (!result) {
      throw new NotFoundException(`Could not resolve academic metadata for query: ${query}`);
    }
    return result;
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
   * Creates a reference record (with or without PDF)
   */
  async createReference(
    workspaceId: string,
    userId: string,
    dto: CreateReferenceDto,
  ) {
    const ws = await this.paperRepo.resolveWorkspace(workspaceId);
    const targetWsId = ws?.id || workspaceId;

    const citationKey =
      dto.citationKey?.trim() ||
      this.bibtexFormatter.generateCitationKey(
        dto.title,
        dto.authors || [],
        dto.year,
      );

    const paper = await this.paperRepo.createPaper({
      title: dto.title,
      authors: dto.authors || [],
      year: dto.year || null,
      doi: dto.doi || '',
      journal: dto.journal || '',
      publisher: dto.publisher || '',
      volume: dto.volume || '',
      issue: dto.issue || '',
      pages: dto.pages || '',
      abstract: dto.abstract || '',
      itemType: dto.itemType || 'journalArticle',
      citationKey,
      url: dto.url || '',
      filename: `${citationKey}.pdf`,
      fileUrl: '', // Reference-only item (no uploaded PDF file initially)
      workspaceId: targetWsId,
      uploadedById: userId,
      collectionId: dto.collectionId || null,
    });

    return { reference: paper };
  }

  /**
   * Exports a single paper or list of papers to a formatted BibTeX string
   */
  formatBibtex(paperOrPapers: BibtexSource | BibtexSource[]): string {
    if (Array.isArray(paperOrPapers)) {
      return this.bibtexFormatter.formatMultiple(paperOrPapers);
    }
    return this.bibtexFormatter.formatEntry(paperOrPapers);
  }

  /**
   * Generates a citation key for any paper metadata
   */
  generateCitationKey(
    title: string,
    authors: string[] = [],
    year?: number | null,
  ): string {
    return this.bibtexFormatter.generateCitationKey(title, authors, year);
  }

  /**
   * Exports all references of a workspace or collection as a complete .bib file
   */
  async exportWorkspaceBibtex(
    workspaceId: string,
    collectionId?: string,
  ): Promise<{ bibtex: string; total: number; filename: string }> {
    const ws = await this.paperRepo.resolveWorkspace(workspaceId);
    const targetWsId = ws?.id || workspaceId;

    const where = {
      workspaceId: targetWsId,
      deletedAt: null,
      ...(collectionId && { collectionId }),
    };

    const papers = await this.paperRepo.findPapers(where, {
      orderBy: [{ createdAt: 'desc' }],
    });

    const bibtex = this.bibtexFormatter.formatMultiple(papers);
    const filename = collectionId
      ? `collection-${collectionId}.bib`
      : `workspace-${workspaceId}.bib`;

    return {
      bibtex,
      total: papers.length,
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
    const ws = await this.paperRepo.resolveWorkspace(workspaceId);
    const targetWsId = ws?.id || workspaceId;

    const parsedEntries = this.bibtexParser.parse(dto.bibtex);
    if (!parsedEntries || parsedEntries.length === 0) {
      return { imported: 0, papers: [] };
    }

    const createdPapers = [];
    for (const entry of parsedEntries) {
      const citationKey =
        entry.citationKey?.trim() ||
        this.bibtexFormatter.generateCitationKey(
          entry.title,
          entry.authors,
          entry.year,
        );

      const paper = await this.paperRepo.createPaper({
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
        citationKey,
        filename: `${citationKey}.pdf`,
        fileUrl: '',
        workspaceId: targetWsId,
        uploadedById: userId,
        collectionId: dto.collectionId || null,
      });
      createdPapers.push(paper);
    }

    return {
      imported: createdPapers.length,
      papers: createdPapers,
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
   * Imports RIS text and creates master papers
   */
  async importRis(
    workspaceId: string,
    userId: string,
    dto: { content: string; collectionId?: string },
  ) {
    const ws = await this.paperRepo.resolveWorkspace(workspaceId);
    const targetWsId = ws?.id || workspaceId;

    const entries = this.risFormatter.parse(dto.content);
    if (!entries || entries.length === 0) {
      throw new NotFoundException('No valid RIS records found in content');
    }

    const createdPapers = [];
    for (const entry of entries) {
      const citationKey = this.bibtexFormatter.generateCitationKey(
        entry.title,
        entry.authors,
        entry.year,
      );

      const paper = await this.paperRepo.createPaper({
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
        citationKey,
        filename: `${citationKey}.pdf`,
        fileUrl: '',
        workspaceId: targetWsId,
        uploadedById: userId,
        collectionId: dto.collectionId || null,
      });
      createdPapers.push(paper);
    }

    return {
      imported: createdPapers.length,
      papers: createdPapers,
    };
  }

  /**
   * Exports paper metadata into RIS string
   */
  async exportRis(workspaceId: string, paperId: string) {
    const ws = await this.paperRepo.resolveWorkspace(workspaceId);
    const targetWsId = ws?.id || workspaceId;

    const paper = await this.paperRepo.findPaperById(paperId);
    if (!paper || paper.deletedAt || paper.workspaceId !== targetWsId) {
      throw new NotFoundException('Paper not found');
    }

    return {
      ris: this.risFormatter.formatEntry(paper),
      filename: `${paper.citationKey || 'paper'}.ris`,
    };
  }
}


