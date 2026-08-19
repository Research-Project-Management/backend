import { Injectable, NotFoundException } from '@nestjs/common';
import { PaperRepository } from './paper/paper.repository';
import { CslFormatter, FormattedCitation } from './reference/formatters/csl.formatter';
import { AnnotationService } from './annotation/annotation.service';
import { RelationService } from './relation/relation.service';
import { PdfAnnotation } from './annotation/types/annotation.types';
import { RelatedPaperItem } from './relation/types/relation.types';

export interface PaperAcademicBundle {
  paper: any;
  citationApa: FormattedCitation;
  citationIeee: FormattedCitation;
  annotations: PdfAnnotation[];
  totalAnnotations: number;
  relatedPapers: RelatedPaperItem[];
  totalRelatedPapers: number;
}

@Injectable()
export class LibraryService {
  constructor(
    private readonly paperRepo: PaperRepository,
    private readonly cslFormatter: CslFormatter,
    private readonly annotationService: AnnotationService,
    private readonly relationService: RelationService,
  ) {}

  /**
   * Deep Facade: Retrieves the entire academic context of a paper in a single call
   * Returns: Master metadata, APA & IEEE citations, PDF annotations, and bi-directional related papers
   */
  async getPaperAcademicBundle(
    workspaceId: string,
    paperId: string,
  ): Promise<PaperAcademicBundle> {
    const ws = await this.paperRepo.resolveWorkspace(workspaceId);
    const targetWsId = ws?.id || workspaceId;

    const paper = await this.paperRepo.findPaperById(paperId);
    if (!paper || paper.deletedAt || paper.workspaceId !== targetWsId) {
      throw new NotFoundException('Paper not found in this workspace');
    }

    // Parallel resolution of all sub-domain facets
    const [citationApa, citationIeee, annotationsResult, relationsResult] =
      await Promise.all([
        Promise.resolve(this.cslFormatter.formatEntry(paper, 'apa')),
        Promise.resolve(this.cslFormatter.formatEntry(paper, 'ieee', 1)),
        this.annotationService.getAnnotations(workspaceId, paperId),
        this.relationService.getRelatedPapers(workspaceId, paperId),
      ]);

    return {
      paper,
      citationApa,
      citationIeee,
      annotations: annotationsResult.annotations,
      totalAnnotations: annotationsResult.total,
      relatedPapers: relationsResult.relatedPapers,
      totalRelatedPapers: relationsResult.total,
    };
  }
}
