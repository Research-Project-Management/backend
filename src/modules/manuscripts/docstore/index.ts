/**
 * modules/manuscripts/docstore/index.ts
 * Public entrypoint and barrel export for the Manuscripts Docstore subsystem
 * (Document storage, lines array representation, OCC, hashing, domain logic, controllers, repositories).
 */

export * from './docstore.module';
export * from './docstore.service';
export * from './controllers';
export * from './dto/doc.dto';

// Domain (Pure in-process functions, entities, and ports)
export * from './domain';

// Repositories
export { DocstoreRepository } from './repositories/docstore.repository';
export {
  DocArchiveRepository,
  InMemoryDocArchiveRepository,
} from './repositories/doc-archive.repository';
