import { Injectable, NotFoundException } from '@nestjs/common';
import { ItemsRepository } from '../items/items.repository';
import {
  CslFormatter,
  FormattedCitation,
} from '../cite/formatters/csl.formatter';
import { RelationsService } from '../relations/relations.service';
import { PdfAnnotation } from '../annotations/types/annotations.types';
import { RelatedItem } from '../relations/types/relations.types';

export interface ItemContext {
  item: any;
  citationApa: FormattedCitation;
  citationIeee: FormattedCitation;
  annotations: PdfAnnotation[];
  totalAnnotations: number;
  relatedItems: RelatedItem[];
  totalRelatedItems: number;
}

export type ResearchContext = ItemContext;

@Injectable()
export class ContextService {
  constructor(
    private readonly itemsRepo: ItemsRepository,
    private readonly cslFormatter: CslFormatter,
    private readonly relationsService: RelationsService,
  ) {}

  /**
   * Deep Facade: Retrieves the entire academic context of a catalog item in a single call
   * Returns: Master metadata, APA & IEEE citations, PDF annotations, and bi-directional related items
   */
  async getItemResearchContext(
    workspaceId: string,
    itemId: string,
  ): Promise<ItemContext> {
    const targetWsId = await this.itemsRepo.resolveWorkspaceId(workspaceId);

    const item = await this.itemsRepo.findItemById(itemId);
    if (!item || item.deletedAt || item.workspaceId !== targetWsId) {
      throw new NotFoundException('Catalog item not found in this workspace');
    }

    const citationApa = this.cslFormatter.formatEntry(item, 'apa');
    const citationIeee = this.cslFormatter.formatEntry(item, 'ieee', 1);
    const [annotations, relatedItemsResult] = await Promise.all([
      this.itemsRepo.getAnnotations(item.id),
      this.relationsService.getRelatedItems(workspaceId, itemId),
    ]);

    return {
      item,
      citationApa,
      citationIeee,
      annotations,
      totalAnnotations: annotations.length,
      relatedItems: relatedItemsResult.relatedItems,
      totalRelatedItems: relatedItemsResult.total,
    };
  }
}

export { ContextService as ResearchContextService };
