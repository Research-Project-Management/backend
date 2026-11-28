import { Module } from '@nestjs/common';
import { PrismaModule } from '@/core';
import { PagesCoreModule } from '@/modules/pages/core/core.module';
import { StructureModule } from '@/modules/pages/structure/structure.module';
import { DocstoreModule } from '@/modules/pages/docstore/docstore.module';
import { FilestoreModule } from '@/modules/pages/filestore/filestore.module';
import { ClsiModule } from '@/modules/pages/clsi/clsi.module';
import { HistoryModule } from '@/modules/pages/history/history.module';

import { ZipAdapter } from './adapters/zip.adapter';
import { PandocAdapter } from './adapters/pandoc.adapter';
import { PageArchiveAggregatorAdapter } from './adapters/collector.adapter';
import { PageArchiveHydratorAdapter } from './adapters/hydrator.adapter';

import { ExportService } from './services/export.service';
import { ImportService } from './services/import.service';
import { ConvertService } from './services/convert.service';
import { ExportImportController } from './export-import.controller';

@Module({
  imports: [
    PrismaModule,
    PagesCoreModule,
    StructureModule,
    DocstoreModule,
    FilestoreModule,
    ClsiModule,
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
  ],
  exports: [ExportService, ImportService, ConvertService],
})
export class ExportImportModule {}
