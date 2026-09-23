/**
 * export-import/export-import.module.ts
 * NestJS Module configuring Ports, Adapters, Use Cases and Controllers for Project Archiving & Templates.
 */

import { Module } from '@nestjs/common';
import { StructureModule } from '../structure/structure.module';
import { DocstoreModule } from '../docstore/docstore.module';
import { FilestoreModule } from '../filestore/filestore.module';
import { ClsiModule } from '../clsi/clsi.module';

// Ports
import { IZipEnginePort } from './core/ports/zip-engine.port';
import { IManuscriptAggregatorPort } from './core/ports/manuscript-aggregator.port';
import { IManuscriptHydratorPort } from './core/ports/manuscript-hydrator.port';
import { ITemplateCatalogPort } from './core/ports/template-catalog.port';

// Adapters
import { PkzipEngineAdapter } from './core/adapters/engine/pkzip-engine.adapter';
import { ManuscriptAggregatorAdapter } from './core/adapters/external/manuscript-aggregator.adapter';
import { ManuscriptHydratorAdapter } from './core/adapters/external/manuscript-hydrator.adapter';
import { EmbeddedTemplateCatalogAdapter } from './core/adapters/storage/embedded-template-catalog.adapter';

// Use Cases
import { ExportProjectZipUseCase } from './core/use-cases/export-project-zip.use-case';
import { ImportProjectZipUseCase } from './core/use-cases/import-project-zip.use-case';
import { ListTemplatesUseCase } from './core/use-cases/list-templates.use-case';
import { ScaffoldTemplateUseCase } from './core/use-cases/scaffold-template.use-case';

// Service & Controller
import { ExportImportService } from './export-import.service';
import { ExportImportController } from './export-import.controller';

@Module({
  imports: [
    StructureModule,
    DocstoreModule,
    FilestoreModule,
    ClsiModule,
  ],
  controllers: [ExportImportController],
  providers: [
    // Adapters bound to Ports
    {
      provide: IZipEnginePort,
      useClass: PkzipEngineAdapter,
    },
    {
      provide: IManuscriptAggregatorPort,
      useClass: ManuscriptAggregatorAdapter,
    },
    {
      provide: IManuscriptHydratorPort,
      useClass: ManuscriptHydratorAdapter,
    },
    {
      provide: ITemplateCatalogPort,
      useClass: EmbeddedTemplateCatalogAdapter,
    },
    // Use Cases
    ExportProjectZipUseCase,
    ImportProjectZipUseCase,
    ListTemplatesUseCase,
    ScaffoldTemplateUseCase,
    // Facade Service
    ExportImportService,
  ],
  exports: [
    ExportImportService,
    IZipEnginePort,
    IManuscriptAggregatorPort,
    IManuscriptHydratorPort,
    ITemplateCatalogPort,
  ],
})
export class ExportImportModule {}
