import { Injectable, NotFoundException } from '@nestjs/common';
import { CatalogRepository } from './catalog/catalog.repository';
import {
  CslFormatter,
  FormattedCitation,
} from './citation/formatters/csl.formatter';
import { AnnotationsService } from './attachments/annotations/annotations.service';
import { KnowledgeService } from './knowledge/knowledge.service';
import { PdfAnnotation } from './attachments/annotations/annotations.types';
import { RelatedPaperItem } from './knowledge/types/knowledge.types';

export interface CatalogItemAcademicBundle {
  item: any;
  citationApa: FormattedCitation;
  citationIeee: FormattedCitation;
  annotations: PdfAnnotation[];
  totalAnnotations: number;
  relatedItems: RelatedPaperItem[];
  totalRelatedItems: number;
}

@Injectable()
export class LibraryService {
  constructor(
    private readonly catalogRepo: CatalogRepository,
    private readonly cslFormatter: CslFormatter,
    private readonly annotationsService: AnnotationsService,
    private readonly knowledgeService: KnowledgeService,
  ) {}

  /**
   * Deep Facade: Retrieves the entire academic context of a catalog item in a single call
   * Returns: Master metadata, APA & IEEE citations, PDF annotations, and bi-directional related items
   */
  async getCatalogItemAcademicBundle(
    workspaceId: string,
    itemId: string,
  ): Promise<CatalogItemAcademicBundle> {
    const ws = await this.catalogRepo.resolveWorkspace(workspaceId);
    const targetWsId = ws?.id || workspaceId;

    const item = await this.catalogRepo.findItemById(itemId);
    if (!item || item.deletedAt || item.workspaceId !== targetWsId) {
      throw new NotFoundException('Catalog item not found in this workspace');
    }

    // Parallel resolution of all sub-domain facets
    const [citationApa, citationIeee, annotationsResult, relationsResult] =
      await Promise.all([
        Promise.resolve(this.cslFormatter.formatEntry(item, 'apa')),
        Promise.resolve(this.cslFormatter.formatEntry(item, 'ieee', 1)),
        this.annotationsService.getAnnotations(workspaceId, itemId),
        this.knowledgeService.getRelatedPapers(workspaceId, itemId),
      ]);

    return {
      item,
      citationApa,
      citationIeee,
      annotations: annotationsResult.annotations,
      totalAnnotations: annotationsResult.total,
      relatedItems: relationsResult.relatedPapers,
      totalRelatedItems: relationsResult.total,
    };
  }
}
