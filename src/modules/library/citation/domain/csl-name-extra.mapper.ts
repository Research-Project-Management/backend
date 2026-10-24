import {
  CslItemData,
  CslName,
  CslDate,
} from '@/modules/library/citation/types/csl-json.types';
import {
  CSL_TYPE_MAP,
  VIETNAMESE_FAMILY_NAMES,
  VIETNAMESE_COMPOUND_SURNAMES,
  VIETNAMESE_MIDDLE_NAMES,
  isVietnameseName,
  parseCreatorString,
  isInstitutionName,
} from '@/modules/library/core';

export interface ContributorLike {
  fullName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  name?: string | null;
  role?: string | null;
  creatorType?: string | null;
  orderIndex?: number | null;
  fieldMode?: number | string | null;
  shortName?: string | null;
}

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

export const EXTRA_FALLBACK_CSL_STRING_KEYS: Record<string, keyof CslItemData> = {
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

const INSTITUTIONAL_PATTERN =
  /(organization|consortium|association|institute|university|laboratory|committee|team|group|corporation|inc\.|llc|agency|department|ministry|academy|bureau|council|center|centre|foundation|society|openai|google|microsoft|meta|deepmind|who|unesco|ieee|acm|đại học|học viện|viện|trung tâm|bộ giáo dục|bộ y tế|bộ khoa học|tổng cục|cục|sở|ngân hàng|ban quản lý|hội đồng|liên minh)/i;
const DEGREE_REGEX = /^(?:(?:p?gs|ts(?:kh)?|ths|cn|ks|bs|dr|prof|ph\.?d)\.?\s*)+/gi;

export class CslNameMapper {
  private static isVnParts(parts: string[]): boolean {
    if (parts.length < 2) return false;
    if (isVietnameseName(parts.join(' '))) return true;
    if (!VIETNAMESE_FAMILY_NAMES.has(parts[0].toLowerCase())) return false;
    return (
      parts.length >= 3 ||
      (parts.length === 2 && VIETNAMESE_MIDDLE_NAMES.has(parts[1].toLowerCase()))
    );
  }

  public static parseCslDate(dateStr: string): CslDate | undefined {
    if (!dateStr) return undefined;
    const match = dateStr.trim().match(/^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?/);
    if (!match) return undefined;
    const parts: number[] = [Number(match[1])];
    if (match[2]) parts.push(Number(match[2]));
    if (match[3]) parts.push(Number(match[3]));
    return { 'date-parts': [parts] };
  }

  public static formatCslName(contrib: ContributorLike): CslName {
    const attachShort = (target: CslName): CslName => {
      if (contrib.shortName?.trim()) target.short = contrib.shortName.trim();
      return target;
    };

    if (contrib.fieldMode === 1 || contrib.fieldMode === '1') {
      const name =
        contrib.fullName?.trim() ||
        contrib.name?.trim() ||
        contrib.lastName?.trim() ||
        'Anonymous';
      return attachShort({ literal: name });
    }

    if (contrib.lastName?.trim()) {
      const rawLast = contrib.lastName.trim().replace(DEGREE_REGEX, '').trim();
      const rawFirst = contrib.firstName
        ? contrib.firstName.trim().replace(DEGREE_REGEX, '').trim()
        : '';

      if (!rawFirst && rawLast.includes(' ')) {
        return attachShort(this.parseStringName(rawLast));
      }

      if (rawFirst && !rawFirst.includes(',')) {
        const firstParts = rawFirst.split(/\s+/);
        const lastParts = rawLast.split(/\s+/);
        if (
          firstParts.length >= 1 &&
          lastParts.length === 1 &&
          VIETNAMESE_FAMILY_NAMES.has(firstParts[0].toLowerCase()) &&
          !VIETNAMESE_FAMILY_NAMES.has(lastParts[0].toLowerCase())
        ) {
          return attachShort(this.parseStringName(`${rawFirst} ${rawLast}`));
        }
      }

      return attachShort({ family: rawLast, given: rawFirst || undefined });
    }

    const fallbackFull =
      contrib.fullName?.trim() || contrib.name?.trim() || contrib.firstName?.trim();
    return fallbackFull
      ? attachShort(this.parseStringName(fallbackFull))
      : { family: 'Anonymous' };
  }

  public static parseStringName(raw: string): CslName {
    const trimmed = (raw || '')
      .trim()
      .replace(DEGREE_REGEX, '')
      .trim()
      .replace(/\s+/g, ' ');
    if (!trimmed) return { family: 'Anonymous' };

    if (
      (isInstitutionName(trimmed) || INSTITUTIONAL_PATTERN.test(trimmed)) &&
      !trimmed.includes(',')
    ) {
      return { literal: trimmed };
    }

    if (trimmed.includes(',')) {
      const parts = trimmed.split(',').map((p) => p.trim());
      return {
        family: parts[0] || 'Anonymous',
        given: parts.slice(1).join(' ') || undefined,
      };
    }

    const parts = trimmed.split(' ');
    if (parts.length === 1) return { family: parts[0] };

    if (this.isVnParts(parts)) {
      if (parts.length >= 3) {
        const potentialCompound = `${parts[0]} ${parts[1]}`.toLowerCase();
        if (VIETNAMESE_COMPOUND_SURNAMES.has(potentialCompound)) {
          return {
            family: `${parts[0]} ${parts[1]}`,
            given: parts.slice(2).join(' ') || undefined,
          };
        }
      }
      return {
        family: parts[0],
        given: parts.slice(1).join(' ') || undefined,
      };
    }

    if (
      parts.length >= 3 &&
      /^(?:jr\.?|sr\.?|ii|iii|iv|v)$/i.test(parts[parts.length - 1])
    ) {
      const suffix = parts.pop()!;
      const fam = parts.pop() || 'Anonymous';
      const giv = parts.join(' ');
      return { family: fam, given: giv ? `${giv} ${suffix}` : suffix };
    }

    const parsedCreator = parseCreatorString(trimmed, 0, 'author');
    if (parsedCreator.fieldMode === 1) {
      return { literal: parsedCreator.fullName || trimmed };
    }
    if (parsedCreator.lastName) {
      return {
        family: parsedCreator.lastName,
        given: parsedCreator.firstName || undefined,
      };
    }

    const family = parts.pop() || 'Anonymous';
    return { family, given: parts.join(' ') };
  }
}

export class CslExtraMapper {
  public static parseExtraCslVariables(extraStr: string, csl: CslItemData): void {
    if (!extraStr?.trim()) return;
    const cslRec = csl as Record<string, unknown>;

    const applyKeyValue = (rawKeyInput: string, rawValInput: string): boolean => {
      const val = rawValInput.trim();
      if (!val) return false;
      const rawKey = rawKeyInput.trim().toLowerCase().replace(/[\s_]+/g, '-');

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
      const match = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_.\s-]{0,40}):\s*(.+)$/);
      if (!match || !applyKeyValue(match[1], match[2])) {
        remainingNotes.push(trimmed);
      }
    }

    if (remainingNotes.length > 0) {
      csl.note = remainingNotes.join('\n');
    }
  }
}
