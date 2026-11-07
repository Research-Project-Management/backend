/**
 * modules/pages/pages.module.ts
 * Root NestJS Module for Pages subsystem (Overleaf-parity architecture).
 *
 * Organized into 5 Core Authoring Subsystems (Topological Dependency Order):
 * - Subsystem 0 (Shared Kernel): PagesCoreModule
 * - Subsystem 1 (Virtual File System & Storage): FilestoreModule -> DocstoreModule -> StructureModule
 * - Subsystem 3 (Compilation & Diagnostics): DiagnosticsModule -> ClsiModule
 * - Subsystem 4 (Review & Versioning): TrackChangesModule -> ProjectHistoryModule
 * - Subsystem 5 (Academic Authoring & Packaging): SpellingModule -> CitationsModule -> TemplatesModule -> ExportImportModule -> GitBridgeModule
 * (Note: Subsystem 2 - Real-time Collaboration lives in @/modules/realtime/pages)
 */

import { Module } from '@nestjs/common';

// Subsystem 0: Shared Kernel
import { ManuscriptsCoreModule } from './core/core.module';

// Subsystem 1: Virtual File System & Storage (Unified with @/modules/storage/core)
import { FilestoreModule } from './filestore/filestore.module';
import { DocstoreModule } from './docstore/docstore.module';
import { StructureModule } from './structure/structure.module';

// Subsystem 3: Compilation & Diagnostics
import { DiagnosticsModule } from './diagnostics/diagnostics.module';
import { ClsiModule } from './clsi/clsi.module';

// Subsystem 4: Review & Versioning
import { TrackChangesModule } from './track-changes/track-changes.module';
import { ProjectHistoryModule } from './project-history/project-history.module';

// Subsystem 5: Academic Authoring & Packaging
import { SpellingModule } from './spelling/spelling.module';
import { CitationsModule } from './citations/citations.module';
import { TemplatesModule } from './templates/templates.module';
import { ExportImportModule } from './export-import/export-import.module';
import { GitBridgeModule } from './git-bridge/git-bridge.module';

import { PagesFacade } from './pages.facade';

@Module({
  imports: [
    // Tier 0: Shared Kernel
    ManuscriptsCoreModule,

    // Tier 1 (Subsystem 1): VFS & Storage
    FilestoreModule,
    DocstoreModule,
    StructureModule,

    // Tier 2 (Subsystem 3): Compilation & Diagnostics
    DiagnosticsModule,
    ClsiModule,

    // Tier 3 (Subsystem 4): Review & Versioning
    TrackChangesModule,
    ProjectHistoryModule,

    // Tier 4 (Subsystem 5): Academic Authoring & Packaging
    SpellingModule,
    CitationsModule,
    TemplatesModule,
    ExportImportModule,
    GitBridgeModule,
  ],
  providers: [PagesFacade],
  exports: [
    PagesFacade,
    ManuscriptsCoreModule,

    // Subsystem 1: VFS & Storage
    FilestoreModule,
    DocstoreModule,
    StructureModule,

    // Subsystem 3: Compilation & Diagnostics
    DiagnosticsModule,
    ClsiModule,

    // Subsystem 4: Review & Versioning
    TrackChangesModule,
    ProjectHistoryModule,

    // Subsystem 5: Academic Authoring & Packaging
    SpellingModule,
    CitationsModule,
    TemplatesModule,
    ExportImportModule,
    GitBridgeModule,
  ],
})
export class PagesModule {}
export { PagesModule as ManuscriptsModule };
