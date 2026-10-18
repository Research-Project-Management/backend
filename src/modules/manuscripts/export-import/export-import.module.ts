/**
 * modules/manuscripts/export-import/export-import.module.ts
 * NestJS Module configuring ExportImportService, Controller, and Repositories.
 * Pure domain modules (document-transpiler, archive-validator) run in-process without DI ceremony.
 */

import { Module } from '@nestjs/common';
import { StructureModule } from '@/modules/manuscripts/structure/structure.module';
import { DocstoreModule } from '@/modules/manuscripts/docstore/docstore.module';
import { FilestoreModule } from '@/modules/manuscripts/filestore/filestore.module';
import { ClsiModule } from '@/modules/manuscripts/clsi/clsi.module';

// Ports & Engines
import {
  IZipEnginePort,
  IManuscriptAggregatorPort,
  IManuscriptHydratorPort,
  ITemplateCatalogPort,
  PkzipEngineAdapter,
} from './domain';

// Repositories
import {
  ManuscriptAggregatorAdapter,
  ManuscriptHydratorAdapter,
  EmbeddedTemplateCatalogAdapter,
} from './repositories/manuscript-aggregator.repository';

// Service & Controller
import { ExportImportService } from './export-import.service';
import { ExportImportController } from './export-import.controller';

@Module({
  imports: [StructureModule, DocstoreModule, FilestoreModule, ClsiModule],
  controllers: [ExportImportController],
  providers: [
    PkzipEngineAdapter,
    ManuscriptAggregatorAdapter,
    ManuscriptHydratorAdapter,
    EmbeddedTemplateCatalogAdapter,
    {
      provide: IZipEnginePort,
      useExisting: PkzipEngineAdapter,
    },
    {
      provide: IManuscriptAggregatorPort,
      useExisting: ManuscriptAggregatorAdapter,
    },
    {
      provide: IManuscriptHydratorPort,
      useExisting: ManuscriptHydratorAdapter,
    },
    {
      provide: ITemplateCatalogPort,
      useExisting: EmbeddedTemplateCatalogAdapter,
    },
    {
      provide: ExportImportService,
      useFactory: (
        aggregator: IManuscriptAggregatorPort,
        zipEngine: IZipEnginePort,
        hydrator: IManuscriptHydratorPort,
        catalog: ITemplateCatalogPort,
      ) => new ExportImportService(aggregator, zipEngine, hydrator, catalog),
      inject: [
        IManuscriptAggregatorPort,
        IZipEnginePort,
        IManuscriptHydratorPort,
        ITemplateCatalogPort,
      ],
    },
  ],
  exports: [
    ExportImportService,
    ManuscriptAggregatorAdapter,
    IZipEnginePort,
    IManuscriptAggregatorPort,
    IManuscriptHydratorPort,
    ITemplateCatalogPort,
  ],
})
export class ExportImportModule {}
