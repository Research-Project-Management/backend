export {
  normalizeDoi,
  normalizeArxivId,
  normalizePmid,
  normalizePmcid,
  normalizeIsbn,
  normalizeIssn,
  formatCanonicalId,
  extractYearFromDate,
  normalizeCreators,
  normalizeItemType,
  normalizeLibraryItemType,
} from '../../catalog/utils/item.utils';

export type { CreatorInput, IdentifierScheme } from '../../catalog/types/item.types';

export { normalizeTags } from '../../tags/utils/tags.utils';
export type { TagInput, TagObjectInput } from '../../tags/types/tag.types';


