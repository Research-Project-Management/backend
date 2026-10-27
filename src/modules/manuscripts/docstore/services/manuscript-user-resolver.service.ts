/**
 * modules/manuscripts/docstore/services/manuscript-user-resolver.service.ts
 * Re-exports ManuscriptUserResolverService from the Manuscripts Shared Kernel (`manuscripts/core`)
 * to preserve backwards compatibility while keeping dependency direction strictly downward.
 */

export {
  ManuscriptUserResolverService,
  type ResolvedManuscriptUser,
} from '@/modules/manuscripts/core/services/manuscript-user-resolver.service';
