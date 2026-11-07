/**
 * modules/manuscripts/export-import/export-import.module.ts
 * NestJS Module configuring ExportImportService, Controller, and Repositories.
 * Pure domain modules (document-transpiler, archive-validator) run in-process without DI ceremony.
 */

import { Module } from '@nestjs/common';
import { ManuscriptsCoreModule } from '@/modules/pages/core';
import { StructureModule } from '@/modules/pages/structure/structure.module';
import { DocstoreModule } from '@/modules/pages/docstore/docstore.module';
import { FilestoreModule } from '@/modules/pages/filestore/filestore.module';
import { ClsiModule } from '@/modules/pages/clsi/clsi.module';
import { TemplatesModule } from '@/modules/pages/templates/templates.module';
import { TemplatesService } from '@/modules/pages/templates/templates.service';
import { ProjectHistoryModule } from '@/modules/pages/project-history/project-history.module';
import { HistoryExportController } from '@/modules/pages/docstore/controllers/history-export.controller';

// Adapters & Repositories
import { ZipAdapter } from './services/zip.adapter';
import { TranspilerAdapter } from './services/transpiler.adapter';
import {
  ManuscriptAggregatorAdapter,
  ManuscriptHydratorAdapter,
} from './repositories/aggregator.repository';

// Service & Controller
import { ExportImportService } from './export-import.service';
import { ExportImportController } from './export-import.controller';

@Module({
  imports: [
    ManuscriptsCoreModule,
    StructureModule,
    DocstoreModule,
    FilestoreModule,
    ClsiModule,
    TemplatesModule,
    ProjectHistoryModule,
  ],
  controllers: [ExportImportController, HistoryExportController],
  providers: [
    ZipAdapter,
    TranspilerAdapter,
    ManuscriptAggregatorAdapter,
    ManuscriptHydratorAdapter,
    ExportImportService,
  ],
  exports: [
    ExportImportService,
    ManuscriptAggregatorAdapter,
    ManuscriptHydratorAdapter,
    ZipAdapter,
    TranspilerAdapter,
  ],
})
export class ExportImportModule {}
