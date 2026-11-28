/**
 * modules/pages/index.ts
 * Public entry point for the Pages Subsystem.
 * Exposes only top-level NestJS modules and public service facades — never internal
 * repositories, adapters, controllers, or domain implementation helpers.
 */

export { PagesModule } from './pages.module';
export { PagesCoreModule, PagesConfigService } from './core';
export { PageModule, PageService, PageScaffoldService } from './page';
export {
  EditorBootstrapModule,
  EditorBootstrapService,
  type BootstrapEditorParams,
  type EditorBootstrapResponseDto,
} from './bootstrap';

// Subsystem 1: Virtual File System & Storage
export { FilestoreModule, FilestoreService } from './filestore';
export { DocstoreModule, DocstoreService } from './docstore';
export { StructureModule, StructureService } from './structure';

// Subsystem 3: Compilation & CLSI
export { ClsiModule, ClsiService } from './clsi';

// Subsystem 4: Review & Versioning
export { ReviewModule } from './review';
export { HistoryModule } from './history';

// Subsystem 5: Academic Authoring & Packaging
export { SpellingModule, SpellingService } from './spelling';
export { CitationsModule, CitationsService } from './citations';
export {
  TemplatesModule,
  GalleryService,
  PublishService,
  InstantiateService,
} from './templates';
export {
  ExportImportModule,
  ExportService,
  ImportService,
  ConvertService,
} from './export-import';
export {
  GitBridgeModule,
  TokenService,
  SyncService,
  MaintenanceService,
} from './git-bridge';
