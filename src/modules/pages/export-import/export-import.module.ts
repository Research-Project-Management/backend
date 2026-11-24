/**
 * modules/manuscripts/export-import/export-import.module.ts
 * NestJS Module configuring ExportImportService, Controller, and Repositories.
 * Pure domain modules (document-transpiler, archive-validator) run in-process without DI ceremony.
 */

import { Module } from '@nestjs/common';
import { PagesCoreModule } from '@/modules/pages/core';
import { StructureModule } from '@/modules/pages/structure/structure.module';
import { DocstoreModule } from '@/modules/pages/docstore/docstore.module';
import { FilestoreModule } from '@/modules/pages/filestore/filestore.module';
import { ClsiModule } from '@/modules/pages/clsi/clsi.module';
import { TemplatesModule } from '@/modules/pages/templates/templates.module';
import { TemplatesService } from '@/modules/pages/templates/templates.service';
import { HistoryModule } from '@/modules/pages/history/history.module';

// Adapters & Repositories
import { ZipAdapter } from './services/zip.adapter';
import { TranspilerAdapter } from './services/transpiler.adapter';
import {
  PageArchiveAggregatorAdapter,
  PageArchiveHydratorAdapter,
} from './repositories/aggregator.repository';

// Service & Controller
import { ExportImportService } from './export-import.service';
import { ExportImportController } from './export-import.controller';

@Module({
  imports: [
    PagesCoreModule,
    StructureModule,
    DocstoreModule,
    FilestoreModule,
    ClsiModule,
    TemplatesModule,
    HistoryModule,
  ],
  controllers: [ExportImportController],
  providers: [
    ZipAdapter,
    TranspilerAdapter,
    PageArchiveAggregatorAdapter,
    PageArchiveHydratorAdapter,
    ExportImportService,
  ],
  exports: [
    ExportImportService,
    PageArchiveAggregatorAdapter,
    PageArchiveHydratorAdapter,
    ZipAdapter,
    TranspilerAdapter,
  ],
})
export class ExportImportModule {}
