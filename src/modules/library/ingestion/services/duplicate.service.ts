import { Injectable, Inject, Optional } from '@nestjs/common';
import {
  TransactionService,
  CATALOG_FACADE,
  ICatalogFacade,
  EXTRACTION_FACADE,
  IExtractionFacade,
  DuplicateCandidateItem,
} from '@/modules/library/core';
import { IngestionRepository } from '@/modules/library/ingestion/repositories/ingestion.repository';
import { MergeDuplicatesDto } from '@/modules/library/ingestion/dto/curation.dto';
import { DuplicateClusterResult } from '@/modules/library/ingestion/types/curation.types';
import { UserId, ProjectId } from '@/modules/library/core/types/branded.types';
import {
  DuplicateDetectorService,
  asMetaObject,
  getEffectiveItemField,
} from './duplicate-detector.service';
import {
  DuplicateMergerService,
  ContributorShape,
  SYSTEM_RESERVED_MERGE_KEYS,
  TOP_LEVEL_ITEM_COLUMNS,
  IDENTIFIER_META_KEYS,
  RETRACTION_SURVIVAL_KEYS,
} from './duplicate-merger.service';

export type { ContributorShape };
export {
  DuplicateDetectorService,
  DuplicateMergerService,
  asMetaObject,
  getEffectiveItemField,
  SYSTEM_RESERVED_MERGE_KEYS,
  TOP_LEVEL_ITEM_COLUMNS,
  IDENTIFIER_META_KEYS,
  RETRACTION_SURVIVAL_KEYS,
};

@Injectable()
export class DuplicateService {
  private readonly detector: DuplicateDetectorService;
  private readonly merger: DuplicateMergerService;

  constructor(
    private readonly libraryTx: TransactionService,
    @Optional()
    @Inject(CATALOG_FACADE)
    private readonly catalogGateway?: ICatalogFacade,
    @Optional()
    @Inject(EXTRACTION_FACADE)
    private readonly extractionGateway?: IExtractionFacade,
    @Optional()
    private readonly ingestionRepo?: IngestionRepository,
    @Optional()
    detector?: DuplicateDetectorService,
    @Optional()
    merger?: DuplicateMergerService,
  ) {
    this.detector =
      detector ??
      new DuplicateDetectorService(
        this.catalogGateway,
        this.ingestionRepo,
        this.libraryTx,
      );
    this.merger =
      merger ??
      new DuplicateMergerService(
        this.libraryTx,
        this.catalogGateway,
        this.extractionGateway,
        this.ingestionRepo,
      );
  }

  computeRecommendedMasterId(group: DuplicateCandidateItem[]): string {
    return this.detector.computeRecommendedMasterId(group);
  }

  async dismissDuplicates(
    userId: UserId | string,
    itemIds: string[],
    projectId?: ProjectId | string,
  ): Promise<{ dismissed: boolean; itemIds: string[] }> {
    return this.detector.dismissDuplicates(userId, itemIds, projectId);
  }

  async detectDuplicates(
    userId: UserId | string,
    projectId?: ProjectId | string,
  ): Promise<DuplicateClusterResult[]> {
    return this.detector.detectDuplicates(userId, projectId);
  }

  async mergeDuplicates(
    userId: UserId | string,
    dto: MergeDuplicatesDto,
    projectId?: ProjectId | string,
  ) {
    return this.merger.mergeDuplicates(userId, dto, projectId);
  }
}
