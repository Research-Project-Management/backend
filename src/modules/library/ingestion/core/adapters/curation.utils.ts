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
  calculateTokenSortRatio,
  tokenizeTitleWords,
  jaroWinkler,
  firstAuthorMatches,
} from '../domain/deduplication.utils';
