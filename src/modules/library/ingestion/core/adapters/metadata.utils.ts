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
  inferItemTypeFromPdfSignals,
  titleSimilarity,
  TITLE_MATCH_THRESHOLD,
} from '../../../shared-kernel/utils/bibliographic.utils';

export type {
  CreatorInput,
  IdentifierScheme,
  TagInput,
  TagObjectInput,
} from '../../../shared-kernel/types/bibliographic.types';

export { normalizeTags } from '../../../shared-kernel/utils/tag.utils';
