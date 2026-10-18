import { CslItemData } from '@/modules/library/citation/types/csl-json.types';
import { CSL_TYPE_MAP } from '@/modules/library/core';
import { CslNameMapper } from './csl-name.mapper';

export const EXTRA_DIRECT_CSL_STRING_KEYS: Record<string, keyof CslItemData> = {
  pmid: 'PMID',
  pmcid: 'PMCID',
  arxiv: 'archive_location',
  arxivid: 'archive_location',
  'archive-location': 'archive-location',
  archivelocation: 'archive-location',
  archive: 'archive',
  'archive-place': 'archive_place',
  archiveplace: 'archive_place',
  genre: 'genre',
  medium: 'medium',
  jurisdiction: 'jurisdiction',
  authority: 'authority',
  status: 'status',
  version: 'version',
  dimensions: 'dimensions',
  scale: 'scale',
  categories: 'categories',
  language: 'language',
  publisher: 'publisher',
  'publisher-place': 'publisher-place',
  publisherplace: 'publisher-place',
  'collection-title': 'collection-title',
  collectiontitle: 'collection-title',
  'collection-number': 'collection-number',
  collectionnumber: 'collection-number',
  'original-title': 'original-title',
  originaltitle: 'original-title',
  edition: 'edition',
  section: 'section',
  chapter: 'chapter-number',
};

export const EXTRA_FALLBACK_CSL_STRING_KEYS: Record<string, keyof CslItemData> =
  {
    abstract: 'abstract',
    shorttitle: 'title-short',
    'short-title': 'title-short',
    'title-short': 'title-short',
    journalabbr: 'container-title-short',
    journalabbreviation: 'container-title-short',
    'journal-abbreviation': 'container-title-short',
    'container-title-short': 'container-title-short',
    event: 'event-title',
    eventtitle: 'event-title',
    'event-title': 'event-title',
    rights: 'rights',
    license: 'rights',
    url: 'URL',
    isbn: 'ISBN',
    issn: 'ISSN',
    callnumber: 'call-number',
    'call-number': 'call-number',
  };

export class CslExtraMapper {
  /**
   * Parses CSL variables and identifiers embedded in Zotero's Extra field
   * using declarative lookup tables.
   */
  public static parseExtraCslVariables(
    extraStr: string,
    csl: CslItemData,
  ): void {
    if (!extraStr || !extraStr.trim()) return;
    const cslRec = csl as Record<string, unknown>;

    const applyKeyValue = (
      rawKeyInput: string,
      rawValInput: string,
    ): boolean => {
      const val = rawValInput.trim();
      if (!val) return false;
      const rawKey = rawKeyInput
        .trim()
        .toLowerCase()
        .replace(/[\s_]+/g, '-');

      if (rawKey === 'original-date' || rawKey === 'originaldate') {
        const parsed = CslNameMapper.parseCslDate(val);
        if (parsed) csl['original-date'] = parsed;
        return true;
      }
      if (rawKey === 'event-date' || rawKey === 'eventdate') {
        const parsed = CslNameMapper.parseCslDate(val);
        if (parsed) csl['event-date'] = parsed;
        return true;
      }
      if (rawKey === 'issued' && !csl.issued) {
        const parsed = CslNameMapper.parseCslDate(val);
        if (parsed) csl.issued = parsed;
        return true;
      }
      if (rawKey === 'accessed' && !csl.accessed) {
        const parsed = CslNameMapper.parseCslDate(val);
        if (parsed) csl.accessed = parsed;
        return true;
      }
      if (rawKey === 'event-place' || rawKey === 'eventplace') {
        csl['event-place'] = val;
        if (!csl['publisher-place']) csl['publisher-place'] = val;
        return true;
      }
      if (
        rawKey === 'article-number' ||
        rawKey === 'articlenumber' ||
        rawKey === 'number'
      ) {
        if (!csl.number) csl.number = val;
        if (rawKey !== 'number') csl['article-number'] = val;
        return true;
      }
      if (rawKey === 'type' || rawKey === 'csl-type') {
        csl.type = CSL_TYPE_MAP[val] || val;
        return true;
      }
      if (
        (rawKey === 'archive-location' || rawKey === 'archivelocation') &&
        !csl['archive-location']
      ) {
        csl['archive-location'] = val;
        csl.archive_location = val;
        return true;
      }
      if (rawKey === 'doi') {
        if (!csl.DOI) {
          csl.DOI = val
            .replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/i, '')
            .trim();
        }
        return true;
      }
      if (rawKey === 'pmid') {
        if (!csl.PMID) csl.PMID = val.replace(/^pmid:\s*/i, '').trim();
        return true;
      }
      if (rawKey === 'pmcid' || rawKey === 'pmc') {
        if (!csl.PMCID) {
          const cleanPmc = val.replace(/^(?:pmcid|pmc):\s*/i, '').trim();
          csl.PMCID = /^PMC/i.test(cleanPmc)
            ? cleanPmc.toUpperCase()
            : `PMC${cleanPmc}`;
        }
        return true;
      }
      if (
        rawKey === 'citation-key' ||
        rawKey === 'citationkey' ||
        rawKey === 'citekey' ||
        rawKey === 'cite-key' ||
        rawKey === 'bibtex' ||
        rawKey === 'tex.ids'
      ) {
        const cleanKey = val.split(/[,\s]+/)[0]?.trim();
        if (cleanKey && !csl['citation-key']) {
          csl.id = cleanKey;
          csl['citation-key'] = cleanKey;
        }
        return true;
      }

      const directTarget = EXTRA_DIRECT_CSL_STRING_KEYS[rawKey];
      if (directTarget) {
        cslRec[directTarget] = val;
        return true;
      }

      const fallbackTarget = EXTRA_FALLBACK_CSL_STRING_KEYS[rawKey];
      if (fallbackTarget) {
        if (!cslRec[fallbackTarget]) cslRec[fallbackTarget] = val;
        return true;
      }

      return false;
    };

    const strippedBraced = extraStr.replace(
      /\{:\s*([a-zA-Z_][a-zA-Z0-9_.\s-]*?)\s*:\s*([^}]+?)\s*\}/g,
      (fullMatch, k: string, v: string) =>
        applyKeyValue(k, v) ? '' : fullMatch,
    );

    const remainingNotes: string[] = [];
    for (const line of strippedBraced.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const match = trimmed.match(
        /^([a-zA-Z_][a-zA-Z0-9_.\s-]{0,40}):\s*(.+)$/,
      );
      if (!match || !applyKeyValue(match[1], match[2])) {
        remainingNotes.push(trimmed);
      }
    }

    if (remainingNotes.length > 0) {
      csl.note = remainingNotes.join('\n');
    }
  }
}
