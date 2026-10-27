/**
 * modules/manuscripts/export-import/export-import.module.ts
 * NestJS Module configuring ExportImportService, Controller, and Repositories.
 * Pure domain modules (document-transpiler, archive-validator) run in-process without DI ceremony.
 */

import { Module, forwardRef } from '@nestjs/common';
import { ManuscriptsCoreModule } from '@/modules/manuscripts/core';
import { StructureModule } from '@/modules/manuscripts/structure/structure.module';
import { DocstoreModule } from '@/modules/manuscripts/docstore/docstore.module';
import { FilestoreModule } from '@/modules/manuscripts/filestore/filestore.module';
import { ClsiModule } from '@/modules/manuscripts/clsi/clsi.module';
import { TemplatesModule } from '@/modules/manuscripts/templates/templates.module';
import { TemplatesService } from '@/modules/manuscripts/templates/templates.service';

// Ports & Engines
import {
  IZipEnginePort,
  IManuscriptAggregatorPort,
  IManuscriptHydratorPort,
  IDocumentTranspilerPort,
} from './domain';
import { PkzipEngineAdapter } from './services/pkzip-engine.adapter';
import { DocumentTranspilerAdapter } from './services/document-transpiler.adapter';

// Repositories
import {
  ManuscriptAggregatorAdapter,
  ManuscriptHydratorAdapter,
} from './repositories/manuscript-aggregator.repository';

// Service & Controller
import { ExportImportService } from './export-import.service';
import { ExportImportController } from './export-import.controller';

@Module({
  imports: [
    ManuscriptsCoreModule,
    forwardRef(() => StructureModule),
    forwardRef(() => DocstoreModule),
    FilestoreModule,
    forwardRef(() => ClsiModule),
    TemplatesModule,
  ],
  controllers: [ExportImportController],
  providers: [
    PkzipEngineAdapter,
    DocumentTranspilerAdapter,
    ManuscriptAggregatorAdapter,
    ManuscriptHydratorAdapter,
    {
      provide: IZipEnginePort,
      useExisting: PkzipEngineAdapter,
    },
    {
      provide: IDocumentTranspilerPort,
      useExisting: DocumentTranspilerAdapter,
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
      provide: ExportImportService,
      useFactory: (
        aggregator: IManuscriptAggregatorPort,
        zipEngine: IZipEnginePort,
        hydrator: IManuscriptHydratorPort,
        templatesService: TemplatesService,
        transpiler: IDocumentTranspilerPort,
      ) =>
        new ExportImportService(
          aggregator,
          zipEngine,
          hydrator,
          templatesService,
          transpiler,
        ),
      inject: [
        IManuscriptAggregatorPort,
        IZipEnginePort,
        IManuscriptHydratorPort,
        TemplatesService,
        IDocumentTranspilerPort,
      ],
    },
  ],
  exports: [
    ExportImportService,
    ManuscriptAggregatorAdapter,
    IZipEnginePort,
    IDocumentTranspilerPort,
    IManuscriptAggregatorPort,
    IManuscriptHydratorPort,
  ],
})
export class ExportImportModule {}
