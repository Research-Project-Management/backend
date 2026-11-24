/**
 * modules/pages/pages.module.ts
 * Root NestJS Module for Pages subsystem (Overleaf-parity architecture).
 *
 * Organized into 5 Core Authoring Subsystems (Topological Dependency Order):
 * - Subsystem 0 (Shared Kernel): PagesCoreModule
 * - Subsystem 1 (Virtual File System & Storage): FilestoreModule -> DocstoreModule -> StructureModule
 * - Subsystem 3 (Compilation & Diagnostics): DiagnosticsModule -> ClsiModule
 * - Subsystem 4 (Review & Versioning): ReviewModule -> HistoryModule
 * - Subsystem 5 (Academic Authoring & Packaging): SpellingModule -> CitationsModule -> TemplatesModule -> ExportImportModule -> GitBridgeModule
 * (Note: Subsystem 2 - Real-time Collaboration lives in @/modules/realtime/channels/pages)
 */

import { Module } from '@nestjs/common';

// Subsystem 0: Shared Kernel
import { PagesCoreModule } from './core/core.module';

// Subsystem 1: Virtual File System & Storage (Unified with @/modules/files)
import { FilestoreModule } from './filestore/filestore.module';
import { DocstoreModule } from './docstore/docstore.module';
import { StructureModule } from './structure/structure.module';

// Subsystem 3: Compilation
import { ClsiModule } from './clsi/clsi.module';

// Subsystem 4: Review & Versioning
import { ReviewModule } from './review/review.module';
import { HistoryModule } from './history/history.module';

// Subsystem 5: Academic Authoring & Packaging
import { SpellingModule } from './spelling/spelling.module';
import { CitationsModule } from './citations/citations.module';
import { TemplatesModule } from './templates/templates.module';
import { ExportImportModule } from './export-import/export-import.module';
import { GitBridgeModule } from './git-bridge/git-bridge.module';
import { EditorBootstrapModule } from './bootstrap/editor-bootstrap.module';

import { PagesFacade } from './pages.facade';

@Module({
  imports: [
    // Tier 0: Shared Kernel
    PagesCoreModule,

    // Tier 1 (Subsystem 1): VFS & Storage
    FilestoreModule,
    DocstoreModule,
    StructureModule,

    // Tier 2 (Subsystem 3): Compilation
    ClsiModule,

    // Tier 3 (Subsystem 4): Review & Versioning
    ReviewModule,
    HistoryModule,

    // Tier 4 (Subsystem 5): Academic Authoring & Packaging
    SpellingModule,
    CitationsModule,
    TemplatesModule,
    ExportImportModule,
    GitBridgeModule,

    // Unified Editor Bootstrap BFF
    EditorBootstrapModule,
  ],
  providers: [PagesFacade],
  exports: [
    PagesFacade,
    PagesCoreModule,
    EditorBootstrapModule,

    // Subsystem 1: VFS & Storage
    FilestoreModule,
    DocstoreModule,
    StructureModule,

    // Subsystem 3: Compilation
    ClsiModule,

    // Subsystem 4: Review & Versioning
    ReviewModule,
    HistoryModule,

    // Subsystem 5: Academic Authoring & Packaging
    SpellingModule,
    CitationsModule,
    TemplatesModule,
    ExportImportModule,
    GitBridgeModule,
  ],
})
export class PagesModule {}
