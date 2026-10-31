/**
 * modules/manuscripts/manuscripts.module.ts
 * Root NestJS Module for Manuscripts subsystem (Overleaf-parity architecture)
 */

import { Module } from '@nestjs/common';
import { ManuscriptsCoreModule } from './core/core.module';
import { FilestoreModule } from './filestore/filestore.module';
import { DocstoreModule } from './docstore/docstore.module';
import { StructureModule } from './structure/structure.module';
import { ClsiModule } from './clsi/clsi.module';
import { TrackChangesModule } from './track-changes/track-changes.module';
import { TemplatesModule } from './templates/templates.module';
import { ProjectHistoryModule } from './project-history/project-history.module';
import { ExportImportModule } from './export-import/export-import.module';
import { DiagnosticsModule } from './diagnostics/diagnostics.module';
import { CitationsModule } from './citations/citations.module';
import { SpellingModule } from './spelling/spelling.module';
import { LinkedFilesModule } from './linked-files/linked-files.module';
import { GitBridgeModule } from './git-bridge/git-bridge.module';
import { ManuscriptsFacade } from './manuscripts.facade';

@Module({
  imports: [
    ManuscriptsCoreModule,
    FilestoreModule,
    DocstoreModule,
    StructureModule,
    ClsiModule,
    TrackChangesModule,
    TemplatesModule,
    ProjectHistoryModule,
    ExportImportModule,
    DiagnosticsModule,
    CitationsModule,
    SpellingModule,
    LinkedFilesModule,
    GitBridgeModule,
  ],
  providers: [ManuscriptsFacade],
  exports: [
    ManuscriptsFacade,
    ManuscriptsCoreModule,
    ClsiModule,
    DocstoreModule,
    StructureModule,
    FilestoreModule,
    ProjectHistoryModule,
    TrackChangesModule,
    ExportImportModule,
    DiagnosticsModule,
    CitationsModule,
    SpellingModule,
    TemplatesModule,
    LinkedFilesModule,
    GitBridgeModule,
  ],
})
export class ManuscriptsModule {}
