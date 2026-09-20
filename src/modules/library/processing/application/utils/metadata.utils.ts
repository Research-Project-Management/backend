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
  cleanAbstractText,
  cleanBannedString,
  cleanCommentText,
} from '../../../catalog/application/utils/items.utils';

export type {
  CreatorInput,
  IdentifierScheme,
} from '../../../catalog/domain/types/items.types';

export { normalizeTags } from '../../../catalog/application/utils/tags.utils';
export type {
  TagInput,
  TagObjectInput,
} from '../../../catalog/domain/types/tags.types';
