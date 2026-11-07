/**
 * modules/manuscripts/docstore/index.ts
 * Public entrypoint and barrel export for the Manuscripts Docstore subsystem
 * (Document storage, lines array representation, OCC, hashing, domain logic, controllers, repositories).
 */

export * from './docstore.module';
export * from './docstore.service';
export { PageService, ManuscriptPageService } from '../core/services/page.service';
export * from './controllers';
export * from './dto/doc.dto';

// Domain (Pure in-process functions, entities, and ports)
export * from './domain';

// Repositories & Services
export { DocstoreRepository } from './repositories/docstore.repository';
export { ScopeRepository, ManuscriptPageScopeRepository } from './repositories/scope.repository';
export { BootstrapService, ManuscriptProjectBootstrapService } from './services/bootstrap.service';
export { PresenceService, ManuscriptPresenceService } from './services/presence.service';
export { SearchReplaceService, ManuscriptSearchReplaceService } from './services/search-replace.service';
export {
  DocArchiveRepository,
  InMemoryDocArchiveRepository,
  StoragePortDocArchiveAdapter,
} from './repositories/archive.repository';
