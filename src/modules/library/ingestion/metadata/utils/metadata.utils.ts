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
  decodeHtmlEntities,
  stripXmlAndHtmlTags,
  cleanBibliographicText,
  cleanBannedString,
} from '../../../items/utils/items.utils';

export type {
  CreatorInput,
  IdentifierScheme,
} from '../../../items/types/items.types';

export { normalizeTags } from '../../../tags/utils/tags.utils';
export type { TagInput, TagObjectInput } from '../../../tags/types/tags.types';
