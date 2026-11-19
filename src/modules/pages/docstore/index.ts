/**
 * modules/manuscripts/docstore/index.ts
 * Public entrypoint and barrel export for the Manuscripts Docstore subsystem
 * (Document storage, lines array representation, OCC, hashing, domain logic, controllers, repositories).
 */

export * from './docstore.module';
export * from './docstore.service';
export { PageService } from '../core/services/page.service';
export * from './controllers';
export * from './dto/doc.dto';

// Domain (Pure in-process functions, entities, and ports)
export * from './domain';

// Repositories & Services
export { DocstoreRepository } from './repositories/docstore.repository';
export { ScopeRepository } from './repositories/scope.repository';
export { PageScaffoldService } from './services/page-scaffold.service';
export { PresenceService } from './services/presence.service';
export { SearchReplaceService } from './services/search-replace.service';
export {
  DocArchiveRepository,
  InMemoryDocArchiveRepository,
  StoragePortDocArchiveAdapter,
} from './repositories/archive.repository';
