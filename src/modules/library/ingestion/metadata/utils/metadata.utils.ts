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
} from '../../../items/items.utils';

export {
  decodeHtmlEntities,
  stripXmlAndHtmlTags,
  cleanBibliographicText,
  cleanBannedString,
} from '../../../items/text-cleaner.util';

export type {
  CreatorInput,
  IdentifierScheme,
} from '../../../items/items.types';

export { normalizeTags } from '../../../tags/utils/tags.utils';
export type { TagInput, TagObjectInput } from '../../../tags/types/tag.types';
