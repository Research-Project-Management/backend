/**
 * modules/manuscripts/docstore/core/adapters/database/prisma-doc.repository.ts
 * Backward-compatible re-export of DocstoreRepository.
 */

export {
  DocstoreRepository,
  DocstoreRepository as PrismaDocRepository,
} from '@/modules/manuscripts/docstore/repositories/docstore.repository';
export type {
  CreateDocData,
  UpdateDocData,
  PatchDocData,
} from '@/modules/manuscripts/docstore/repositories/docstore.repository';
