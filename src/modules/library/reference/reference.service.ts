import { Injectable, NotFoundException } from '@nestjs/common';
import { PaperRepository } from '../paper/paper.repository';
import { BibtexFormatter, BibtexSource } from './formatters/bibtex.formatter';
import { DoiResolver, ResolvedDoiMetadata } from './resolvers/doi.resolver';
import { CreateReferenceDto } from './dto/reference.dto';

@Injectable()
export class ReferenceService {
  constructor(
    private readonly paperRepo: PaperRepository,
    private readonly bibtexFormatter: BibtexFormatter,
    private readonly doiResolver: DoiResolver,
  ) {}

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
}
