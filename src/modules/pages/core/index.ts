/**
 * modules/pages/core/index.ts
 * Shared Kernel entry point for the Pages subsystem.
 * Ordered bottom-up (domain/errors/ports/utils -> services -> NestJS module) for CommonJS safety.
 */

export { PAGES_CACHE_KEYS } from './config/cache-keys';
export {
  type PagesEnvConfig,
  PagesConfigService,
  pagesConfig,
  readPagesConfig,
  getSafeHostEnv,
  getClsiSandboxEnv,
} from './config/pages.config';
export {
  type PagesDomainErrorOptions,
  PagesDomainError,
  StructureError,
  InvalidNodeNameError,
} from './domain/errors';
export { escapeLatex } from './domain/latex-escape';
export {
  type UnicodePreambleResolution,
  hasVietnameseCharacters,
  resolveUnicodePreamblePackages,
} from './domain/latex-preamble';
export {
  KNOWN_TEXT_EXTENSIONS,
  KNOWN_BINARY_EXTENSIONS,
  isTextPath,
} from './domain/text-extensions';
export { PageDomainEventBus } from './events/event-bus.service';
export {
  type LivePresenceUser,
  LiveCollaborationPort,
  LIVE_COLLABORATION_PORT,
  NoopLiveCollaborationAdapter,
  NOOP_LIVE_COLLABORATION,
} from './ports/live-collaboration.port';
export type { WorkspaceFile, CompilationPayload } from './types/workspace-file';
export {
  type ParsedFolderSegment,
  type ParsedNodePath,
  MAX_VIRTUAL_TREE_DEPTH,
  NodePathVo,
} from './utils/node-path';
export {
  type PageScopeDbClient,
  ensureCanonicalPageId,
  resolveSpaceRootDocIds,
  resolvePageControllerCoordinates,
  resolveActiveProjectId,
  getRecordSpaceId,
  isRecordDeleted,
  filterRecordsByPageScope,
  resolveCanonicalPageId,
  resolveProjectIdByEntityId,
  isPrismaUniqueConstraintError,
} from './utils/page-scope';
export {
  hydratePageDocLines,
  findPageRecordWithNode,
  formatPageByIdResponse,
  assertExpectedVersionAndRev,
  executeDocstoreUpdateWithOcc,
} from './utils/doc-occ.helper';
export {
  ensurePrismaFolderChain,
  isPrismaUniqueError,
} from './utils/folder-chain';
export {
  type ZipEntry,
  crc32,
  buildZipBuffer,
  createZipStream,
} from './utils/zip-builder';
export {
  type SagaExecutionOptions,
  type SagaRunnerOptions,
  SagaRunner,
} from './utils/saga-runner';
export {
  type ParsedBibtexEntry,
  parseBibtexEntries,
} from './utils/bibtex-parse';
export {
  type ResolvedPageUser,
  UserResolverService,
} from './services/user-resolver.service';
export {
  type WorkspaceFlushOptions,
  WorkspaceCollectorService,
} from './services/workspace-collector.service';
export { PagesCoreModule } from './core.module';
