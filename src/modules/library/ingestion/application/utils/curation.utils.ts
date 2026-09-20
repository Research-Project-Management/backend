/**
 * Application-level re-exports for curation & deduplication utilities.
 * Pure implementations live in Domain Policy layer (Clean Architecture).
 */
export {
  normalizeTitleForDedupe,
  extractFirstAuthorFamily,
  extractContributorAuthors,
  generateDedupeBucketKey,
  calculateTitleSimilarity,
  firstAuthorMatches,
} from '../../domain/policies/deduplication.utils';
