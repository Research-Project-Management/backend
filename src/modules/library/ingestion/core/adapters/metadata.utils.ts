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
} from '../../../shared-kernel/utils/bibliographic.utils';

export type {
  CreatorInput,
  IdentifierScheme,
  TagInput,
  TagObjectInput,
} from '../../../shared-kernel/types/bibliographic.types';

export { normalizeTags } from '../../../shared-kernel/utils/tag.utils';
