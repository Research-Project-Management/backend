/**
 * modules/manuscripts/export-import/export-import.module.ts
 * NestJS Module configuring ExportImportService, Controller, and Repositories.
 * Pure domain modules (document-transpiler, archive-validator) run in-process without DI ceremony.
 */

import { Module } from '@nestjs/common';
import { ManuscriptsCoreModule } from '@/modules/manuscripts/core';
import { StructureModule } from '@/modules/manuscripts/structure/structure.module';
import { DocstoreModule } from '@/modules/manuscripts/docstore/docstore.module';
import { FilestoreModule } from '@/modules/manuscripts/filestore/filestore.module';
import { ClsiModule } from '@/modules/manuscripts/clsi/clsi.module';
import { TemplatesModule } from '@/modules/manuscripts/templates/templates.module';
import { TemplatesService } from '@/modules/manuscripts/templates/templates.service';
import { ProjectHistoryModule } from '@/modules/manuscripts/project-history/project-history.module';
import { HistoryExportController } from '@/modules/manuscripts/docstore/controllers/history-export.controller';

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
