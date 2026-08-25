import { Injectable, NotFoundException } from '@nestjs/common';
import { CatalogRepository } from '../catalog/catalog.repository';
import {
  CslFormatter,
  FormattedCitation,
} from '../citation/formatters/csl.formatter';
import { AnnotationsService } from '../attachments/annotations/annotations.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { PdfAnnotation } from '../attachments/annotations/annotations.types';
import { RelatedPaperItem } from '../knowledge/types/knowledge.types';

export interface AcademicBundle {
  item: any;
  citationApa: FormattedCitation;
  citationIeee: FormattedCitation;
  annotations: PdfAnnotation[];
  totalAnnotations: number;
  relatedItems: RelatedPaperItem[];
  totalRelatedItems: number;
}

@Injectable()
export class AcademicBundleService {
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
  async getItemAcademicBundle(
    workspaceId: string,
    itemId: string,
  ): Promise<AcademicBundle> {
    const targetWsId = await this.catalogRepo.resolveWorkspaceId(workspaceId);

    const item = await this.catalogRepo.findItemById(itemId);
    if (!item || item.deletedAt || item.workspaceId !== targetWsId) {
      throw new NotFoundException('Catalog item not found in this workspace');
    }

    const citationApa = this.cslFormatter.formatEntry(item, 'apa');
    const citationIeee = this.cslFormatter.formatEntry(item, 'ieee', 1);
    const [annotationsResult, relatedItemsResult] = await Promise.all([
      this.annotationsService.getAnnotations(workspaceId, itemId),
      this.knowledgeService.getRelatedPapers(workspaceId, itemId),
    ]);

    return {
      item,
      citationApa,
      citationIeee,
      annotations: annotationsResult.annotations,
      totalAnnotations: annotationsResult.total,
      relatedItems: relatedItemsResult.relatedPapers,
      totalRelatedItems: relatedItemsResult.total,
    };
  }
}
