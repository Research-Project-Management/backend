/**
 * modules/manuscripts/manuscripts.module.ts
 * Root NestJS Module for Manuscripts subsystem (Overleaf-parity architecture)
 */

import { Module } from '@nestjs/common';
import { ClsiModule } from './clsi/clsi.module';
import { DocstoreModule } from './docstore/docstore.module';
import { StructureModule } from './structure/structure.module';
import { FilestoreModule } from './filestore/filestore.module';
import { DocumentUpdaterModule } from './document-updater/document-updater.module';
import { ProjectHistoryModule } from './project-history/project-history.module';
import { TrackChangesModule } from './track-changes/track-changes.module';
import { ExportImportModule } from './export-import/export-import.module';
import { DiagnosticsModule } from './diagnostics/diagnostics.module';
import { CitationsModule } from './citations/citations.module';
import { SpellingModule } from './spelling/spelling.module';
import { TemplatesModule } from './templates/templates.module';

@Module({
  imports: [
    ClsiModule,
    DocstoreModule,
    StructureModule,
    FilestoreModule,
    DocumentUpdaterModule,
    ProjectHistoryModule,
    TrackChangesModule,
    ExportImportModule,
    DiagnosticsModule,
    CitationsModule,
    SpellingModule,
    TemplatesModule,
  ],
  exports: [
    ClsiModule,
    DocstoreModule,
    StructureModule,
    FilestoreModule,
    DocumentUpdaterModule,
    ProjectHistoryModule,
    TrackChangesModule,
    ExportImportModule,
    DiagnosticsModule,
    CitationsModule,
    SpellingModule,
    TemplatesModule,
  ],
})
export class ManuscriptsModule {}
