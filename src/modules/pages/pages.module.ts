/**
 * modules/pages/pages.module.ts
 * Root NestJS Module for Pages subsystem (Overleaf-parity architecture).
 *
 * Organized into 5 Core Authoring Subsystems (Topological Dependency Order):
 * - Subsystem 0 (Shared Kernel): PagesCoreModule
 * - Subsystem 1 (Virtual File System & Storage): FilestoreModule -> DocstoreModule -> PageModule -> StructureModule
 * - Subsystem 3 (Compilation & Diagnostics): ClsiModule
 * - Subsystem 4 (Review & Versioning): ReviewModule -> HistoryModule
 * - Subsystem 5 (Academic Authoring & Packaging): SpellingModule -> CitationsModule -> TemplatesModule -> ExportImportModule -> GitBridgeModule
 * (Note: Subsystem 2 - Real-time Collaboration lives in @/modules/realtime/channels/pages)
 */

import { Module } from '@nestjs/common';

// Subsystem 0: Shared Kernel
import { PagesCoreModule } from './core';

// Subsystem 1: Virtual File System & Storage (Unified with @/modules/files)
import { FilestoreModule } from './filestore';
import { DocstoreModule } from './docstore';
import { PageModule } from './page';
import { StructureModule } from './structure';

// Subsystem 3: Compilation
import { ClsiModule } from './clsi';

// Subsystem 4: Review & Versioning
import { ReviewModule } from './review';
import { HistoryModule } from './history';

// Subsystem 5: Academic Authoring & Packaging
import { SpellingModule } from './spelling';
import { CitationsModule } from './citations';
import { TemplatesModule } from './templates';
import { ExportImportModule } from './export-import';
import { GitBridgeModule } from './git-bridge';
import { EditorBootstrapModule } from './bootstrap';

@Module({
  imports: [
    // Tier 0: Shared Kernel
    PagesCoreModule,

    // Tier 1 (Subsystem 1): VFS & Storage + Page Management
    FilestoreModule,
    DocstoreModule,
    PageModule,
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
  exports: [
    PagesCoreModule,
    PageModule,
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
