import { Module } from '@nestjs/common';
import { PagesCoreModule } from '@/modules/pages/core';
import { StructureModule } from '@/modules/pages/structure/structure.module';
import { DocstoreModule } from '@/modules/pages/docstore/docstore.module';
import { FilestoreModule } from '@/modules/pages/filestore/filestore.module';
import { ClsiModule } from '@/modules/pages/clsi/clsi.module';
import { TemplatesModule } from '@/modules/pages/templates/templates.module';
import { HistoryModule } from '@/modules/pages/history/history.module';

import { ZipAdapter } from './adapters/zip.adapter';
import { PandocAdapter } from './adapters/pandoc.adapter';
import { PageArchiveAggregatorAdapter } from './adapters/collector.adapter';
import { PageArchiveHydratorAdapter } from './adapters/hydrator.adapter';

import { ExportService } from './services/export.service';
import { ImportService } from './services/import.service';
import { ConvertService } from './services/convert.service';
import { ScaffoldService } from './services/scaffold.service';
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
    PandocAdapter,
    PageArchiveAggregatorAdapter,
    PageArchiveHydratorAdapter,
    ExportService,
    ImportService,
    ConvertService,
    ScaffoldService,
  ],
  exports: [
    ExportService,
    ImportService,
    ConvertService,
    ScaffoldService,
    PageArchiveAggregatorAdapter,
    PageArchiveHydratorAdapter,
    ZipAdapter,
    PandocAdapter,
  ],
})
export class ExportImportModule {}
