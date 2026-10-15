/**
 * modules/manuscripts/docstore/core/adapters/storage/s3-doc-persistor.adapter.ts
 * Backward-compatible re-export of DocArchiveRepository.
 */

export {
  DocArchiveRepository,
  DocArchiveRepository as S3DocPersistorAdapter,
  InMemoryDocArchiveRepository,
} from '@/modules/manuscripts/docstore/repositories/doc-archive.repository';
