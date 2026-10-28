import {
  stripLatexBraces,
  normalizeDoi,
  parseCreatorString,
  mapCslTypeToZoteroItemType,
} from '@/modules/library/core';
import { normalizeAcademicTags } from '@/modules/library/core/domain/tag.domain';

export interface ParsedBibtexEntry {
  citationKey?: string;
  itemType: string;
  title: string;
  shortTitle?: string;
  authors: string[];
  editors?: string[];
  creators?: Array<{
    name?: string;
    fullName?: string;
    firstName?: string;
    lastName?: string;
    creatorType: string;
    fieldMode?: number;
  }>;
  year: number | null;
  publicationDate?: string;
  journal?: string;
  journalAbbr?: string;
  publisher?: string;
  university?: string;
  institution?: string;
  thesisType?: string;
  reportNumber?: string;
  reportType?: string;
  bookTitle?: string;
  proceedingsTitle?: string;
  conferenceName?: string;
  eventPlace?: string;
  place?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  numPages?: string;
  numberOfVolumes?: string;
  seriesNumber?: string;
  chapter?: string;
  doi?: string;
  pmid?: string;
  pmcid?: string;
  isbn?: string;
  issn?: string;
  url?: string;
  accessedAt?: string;
  abstract?: string;
  series?: string;
  edition?: string;
  keywords?: string[];
  tags?: string[];
  notes?: string[];
  language?: string;
  rights?: string;
  fileUrl?: string;
  extra?: string;
  arxivId?: string;
  seeAlso?: string[];
  relations?: Record<string, string | string[]>;
  [key: string]: unknown;
}

export type BibtexItem = ParsedBibtexEntry;

export interface CslPerson {
  literal?: string;
  given?: string;
  family?: string;
}

export interface CslItem {
  id?: string;
  type?: string;
  title?: string;
  'title-short'?: string;
  author?: CslPerson[];
  editor?: CslPerson[];
  issued?: {
    'date-parts'?: (number | string)[][];
  };
  keyword?: string | string[];
  keywords?: string | string[];
  subject?: string | string[];
  note?: string | string[];
  annote?: string | string[];
  comment?: string | string[];
  'citation-key'?: string;
  'container-title'?: string;
  'container-title-short'?: string;
  publisher?: string;
  'publisher-place'?: string;
  volume?: string | number;
  issue?: string | number;
  number?: string | number;
  page?: string | number;
  'number-of-pages'?: string | number;
  'number-of-volumes'?: string | number;
  'collection-number'?: string | number;
  DOI?: string;
  PMID?: string;
  PMCID?: string;
  ISBN?: string;
  ISSN?: string;
  URL?: string;
  abstract?: string;
  'collection-title'?: string;
  edition?: string | number;
  language?: string;
  rights?: string;
  arXiv?: string;
  arxiv?: string;
  [key: string]: unknown;
}

export const BIBTEX_TYPE_MAP: Record<string, string> = {
  article: 'journalArticle',
  inproceedings: 'conferencePaper',
  conference: 'conferencePaper',
  proceedings: 'conferencePaper',
  incollection: 'bookSection',
  book: 'book',
  booklet: 'book',
  phdthesis: 'thesis',
  mastersthesis: 'thesis',
  thesis: 'thesis',
  techreport: 'report',
  report: 'report',
  manual: 'report',
  misc: 'webpage',
  online: 'webpage',
  electronic: 'webpage',
  www: 'webpage',
  patent: 'patent',
  software: 'computerProgram',
  code: 'computerProgram',
  unpublished: 'manuscript',
  standard: 'standard',
  dataset: 'dataset',
  data: 'dataset',
  hearing: 'hearing',
  statute: 'statute',
  bill: 'bill',
  legislation: 'statute',
  case: 'case',
  jurisdiction: 'case',
  court: 'case',
  artwork: 'artwork',
  audio: 'audioRecording',
  video: 'videoRecording',
  film: 'film',
  movie: 'film',
  broadcast: 'tvBroadcast',
  podcast: 'podcast',
  presentation: 'presentation',
  talk: 'presentation',
};

/**
 * Clean LaTeX protection braces, decode LaTeX accents, and normalize whitespace.
 */
export function cleanBibtexField(text?: string): string {
  if (!text) return '';
  return stripLatexBraces(text)
    .replace(/\\([#%&_{}])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

export function mapBibtexTypeToItemType(bibtexType: string): string {
  const lower = (bibtexType || '').toLowerCase().trim();
  return BIBTEX_TYPE_MAP[lower] || mapCslTypeToZoteroItemType(lower);
}

/**
 * Splits a raw BibTeX author/editor field on top-level `and` while detecting
 * brace-protected corporate/institutional names like `{World Health Organization}`.
 */
export function extractStructuredBibtexPersons(
  rawField: string | undefined,
  creatorType: string,
): Array<{
  name: string;
  fullName: string;
  firstName: string;
  lastName: string;
  creatorType: string;
  fieldMode?: number;
}> {
  if (!rawField || !rawField.trim()) return [];
  const tokens: string[] = [];
  let depth = 0;
  let lastPos = 0;
  const str = rawField.trim();
  const andRe = /\s+and\s+/iy;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') {
      i++;
      continue;
    }
    if (str[i] === '{') depth++;
    else if (str[i] === '}') depth = Math.max(0, depth - 1);
    else if (depth === 0) {
      andRe.lastIndex = i;
      const andMatch = andRe.exec(str);
      if (andMatch) {
        tokens.push(str.slice(lastPos, i).trim());
        i += andMatch[0].length - 1;
        lastPos = i + 1;
      }
    }
  }
  if (lastPos < str.length) {
    tokens.push(str.slice(lastPos).trim());
  }

  const isOthersToken = (name: string) =>
    /^(?:others|and\s+others|et\s+al\.?)$/i.test(name.trim());

  const results: Array<{
    name: string;
    fullName: string;
    firstName: string;
    lastName: string;
    creatorType: string;
    fieldMode?: number;
  }> = [];

  for (const token of tokens) {
    if (!token) continue;
    const isBracedInstitutional =
      token.startsWith('{') &&
      token.endsWith('}') &&
      !token.slice(1, -1).includes('}{');
    const cleaned = cleanBibtexField(token);
    if (!cleaned || isOthersToken(cleaned)) continue;

    if (isBracedInstitutional) {
      results.push({
        name: cleaned,
        fullName: cleaned,
        firstName: '',
        lastName: cleaned,
        creatorType,
        fieldMode: 1,
      });
    } else {
      const parsed = parseCreatorString(cleaned, results.length, creatorType);
      results.push({
        name: parsed.fullName || cleaned,
        fullName: parsed.fullName || cleaned,
        firstName: parsed.firstName,
        lastName: parsed.lastName,
        creatorType,
        fieldMode: parsed.fieldMode ?? 0,
      });
    }
  }

  return results;
}

export function mapCslPersonListToStrings(persons: CslPerson[] = []): string[] {
  const isOthersToken = (name: string) =>
    /^(?:others|and\s+others|et\s+al\.?)$/i.test(name.trim());
  return persons
    .map((p: CslPerson) => {
      if (p.literal) return cleanBibtexField(p.literal);
      if (p.given && p.family)
        return cleanBibtexField(`${p.given} ${p.family}`);
      return cleanBibtexField(p.family || p.given || '');
    })
    .filter((name) => Boolean(name) && !isOthersToken(name));
}

export function mapCslPersonListToCreators(
  persons: CslPerson[] = [],
  creatorType: string,
): NonNullable<ParsedBibtexEntry['creators']> {
  const isOthersToken = (name: string) =>
    /^(?:others|and\s+others|et\s+al\.?)$/i.test(name.trim());
  return persons
    .map((p: CslPerson) => {
      if (p.literal && !p.given && !p.family) {
        const cleanLit = cleanBibtexField(p.literal);
        return cleanLit && !isOthersToken(cleanLit)
          ? {
              name: cleanLit,
              fullName: cleanLit,
              firstName: '',
              lastName: cleanLit,
              creatorType,
              fieldMode: 1,
            }
          : null;
      }
      const given = cleanBibtexField(p.given);
      const family = cleanBibtexField(p.family);
      const full = [given, family].filter(Boolean).join(' ');
      return full && !isOthersToken(full)
        ? {
            name: full,
            fullName: full,
            firstName: given,
            lastName: family,
            creatorType,
            fieldMode: 0,
          }
        : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
}

export function buildParsedBibtexEntry(
  citationKey: string | undefined,
  rawType: string,
  rawFields: Record<string, string>,
  csl?: CslItem,
): ParsedBibtexEntry {
  const entryTypeLower = (rawType || '').toLowerCase();
  const isOthersToken = (name: string) =>
    /^(?:others|and\s+others|et\s+al\.?)$/i.test(name.trim());

  const structuredRawAuthors = extractStructuredBibtexPersons(
    rawFields.author,
    'author',
  );
  const structuredRawEditors = extractStructuredBibtexPersons(
    rawFields.editor,
    'editor',
  );

  const authors: string[] =
    structuredRawAuthors.length > 0
      ? structuredRawAuthors.map((a) => a.fullName)
      : csl
        ? mapCslPersonListToStrings(csl.author)
        : rawFields.author
          ? rawFields.author
              .split(/\s+and\s+/i)
              .map((a) => cleanBibtexField(a))
              .filter((a) => Boolean(a) && !isOthersToken(a))
          : [];

  const editors: string[] =
    structuredRawEditors.length > 0
      ? structuredRawEditors.map((e) => e.fullName)
      : csl
        ? mapCslPersonListToStrings(csl.editor)
        : rawFields.editor
          ? rawFields.editor
              .split(/\s+and\s+/i)
              .map((e) => cleanBibtexField(e))
              .filter((e) => Boolean(e) && !isOthersToken(e))
          : [];

  const creators = csl
    ? [
        ...(structuredRawAuthors.length > 0
          ? structuredRawAuthors
          : mapCslPersonListToCreators(csl.author, 'author')),
        ...(structuredRawEditors.length > 0
          ? structuredRawEditors
          : mapCslPersonListToCreators(csl.editor, 'editor')),
      ]
    : [...structuredRawAuthors, ...structuredRawEditors];

  const year =
    csl?.issued?.['date-parts']?.[0]?.[0] != null
      ? Number(csl.issued['date-parts'][0][0])
      : rawFields.year
        ? parseInt(rawFields.year, 10) || null
        : rawFields.date
          ? parseInt(rawFields.date.slice(0, 4), 10) || null
          : null;

  const rawArxiv =
    csl?.arXiv ||
    csl?.arxiv ||
    rawFields.eprint ||
    rawFields.arxiv ||
    rawFields.arxivid ||
    (typeof csl?.id === 'string' &&
    csl.id.match(/^(\d{4}\.\d{4,5}(?:v\d+)?)$/)?.[1]
      ? csl.id
      : undefined);
  const isArxivPreprint =
    Boolean(rawArxiv) &&
    (!rawFields.archiveprefix ||
      rawFields.archiveprefix.toLowerCase() === 'arxiv');

  let itemType = entryTypeLower
    ? mapBibtexTypeToItemType(entryTypeLower)
    : mapCslTypeToZoteroItemType(csl?.type || 'article-journal');
  if (
    isArxivPreprint &&
    (itemType === 'webpage' ||
      itemType === 'manuscript' ||
      entryTypeLower === 'online' ||
      entryTypeLower === 'misc' ||
      entryTypeLower === 'unpublished')
  ) {
    itemType = 'preprint';
  }

  const rawKeywords =
    rawFields.keywords ||
    rawFields.keyword ||
    rawFields.tags ||
    csl?.keyword ||
    csl?.keywords ||
    csl?.subject;
  const rawKeywordCandidates: string[] = [];
  if (Array.isArray(rawKeywords)) {
    rawKeywordCandidates.push(
      ...rawKeywords
        .map((k: unknown) => cleanBibtexField(String(k)))
        .filter(Boolean),
    );
  } else if (typeof rawKeywords === 'string' && rawKeywords.trim()) {
    rawKeywordCandidates.push(cleanBibtexField(rawKeywords));
  }
  const normalizedKeywords = normalizeAcademicTags(rawKeywordCandidates);
  const keywords =
    normalizedKeywords.length > 0 ? normalizedKeywords : undefined;

  const hasRawNoteFields = Boolean(
    rawFields.note || rawFields.annote || rawFields.comment,
  );
  const noteCandidates = hasRawNoteFields
    ? [rawFields.note, rawFields.annote, rawFields.comment]
    : csl
      ? [csl.note, csl.annote, csl.comment, csl['annote'], csl['note']]
      : [];
  const collectedNotes: string[] = [];
  const seenNotes = new Set<string>();
  const pushCleanedNote = (val: unknown) => {
    if (typeof val !== 'string' && typeof val !== 'number') return;
    const cleaned = cleanBibtexField(String(val)).trim();
    if (!cleaned) return;
    const lower = cleaned.toLowerCase();
    if (!seenNotes.has(lower)) {
      seenNotes.add(lower);
      collectedNotes.push(cleaned);
    }
  };
  for (const cand of noteCandidates) {
    if (Array.isArray(cand)) {
      for (const elem of cand) pushCleanedNote(elem);
    } else {
      pushCleanedNote(cand);
    }
  }
  const notes = collectedNotes.length > 0 ? collectedNotes : undefined;

  let fileUrl: string | undefined;
  const rawFile = rawFields.file || rawFields.pdf;
  if (rawFile) {
    const firstFileEntry = rawFile.split(/(?<!\\);/)[0]?.trim() || rawFile.trim();
    const jabrefMatch = firstFileEntry.match(/^[^:]*:(.+):[^:]*$/);
    const extractedPath = jabrefMatch ? jabrefMatch[1] : firstFileEntry;
    const cleanFile = extractedPath.replace(/\\:/g, ':').trim();
    if (cleanFile) fileUrl = cleanFile;
  }

  const rawDoi = csl?.DOI || rawFields.doi;
  const normalizedDoi = rawDoi ? normalizeDoi(rawDoi) || rawDoi : undefined;

  const rawTitle = rawFields.title
    ? cleanBibtexField(rawFields.title)
    : cleanBibtexField(csl?.title);

  const university =
    cleanBibtexField(rawFields.school || rawFields.university) ||
    (itemType === 'thesis'
      ? cleanBibtexField(csl?.publisher) || undefined
      : undefined);
  const institution =
    cleanBibtexField(rawFields.institution || rawFields.organization) ||
    (itemType === 'report'
      ? cleanBibtexField(csl?.publisher) || undefined
      : undefined);

  const publisher =
    cleanBibtexField(csl?.publisher || rawFields.publisher) ||
    university ||
    institution ||
    undefined;

  const thesisType =
    itemType === 'thesis'
      ? cleanBibtexField(rawFields.type) ||
        (entryTypeLower === 'phdthesis'
          ? 'PhD thesis'
          : entryTypeLower === 'mastersthesis'
            ? "Master's thesis"
            : undefined)
      : undefined;

  const reportType =
    itemType === 'report'
      ? cleanBibtexField(rawFields.type) || undefined
      : undefined;
  const reportNumber =
    itemType === 'report'
      ? cleanBibtexField(
          rawFields.number ||
            (csl?.number != null ? String(csl.number) : undefined),
        ) || undefined
      : undefined;

  const containerTitle =
    cleanBibtexField(
      csl?.['container-title'] ||
        rawFields.journal ||
        rawFields.journaltitle ||
        rawFields.booktitle,
    ) || undefined;

  const bookTitle =
    itemType === 'bookSection'
      ? cleanBibtexField(rawFields.booktitle || csl?.['container-title']) ||
        undefined
      : undefined;
  const proceedingsTitle =
    itemType === 'conferencePaper'
      ? cleanBibtexField(rawFields.booktitle || csl?.['container-title']) ||
        undefined
      : undefined;
  const conferenceName =
    itemType === 'conferencePaper'
      ? cleanBibtexField(rawFields.eventtitle || rawFields.conference) ||
        undefined
      : undefined;
  const eventPlace =
    cleanBibtexField(
      rawFields.venue || rawFields.eventplace || rawFields.location,
    ) || undefined;

  const place =
    cleanBibtexField(
      csl?.['publisher-place'] ||
        rawFields.address ||
        rawFields.place ||
        rawFields.location ||
        rawFields.venue,
    ) || undefined;

  const seriesNumber =
    (itemType === 'book' ||
      itemType === 'bookSection' ||
      itemType === 'conferencePaper') &&
    rawFields.series &&
    rawFields.number
      ? cleanBibtexField(rawFields.number)
      : csl?.['collection-number'] != null
        ? String(csl['collection-number'])
        : undefined;

  const numPages =
    cleanBibtexField(rawFields.numpages || rawFields.pagetotal) ||
    (csl?.['number-of-pages'] != null
      ? String(csl['number-of-pages'])
      : undefined);

  const numberOfVolumes =
    cleanBibtexField(rawFields.volumes) ||
    (csl?.['number-of-volumes'] != null
      ? String(csl['number-of-volumes'])
      : undefined);

  const chapter = cleanBibtexField(rawFields.chapter) || undefined;

  const shortTitle =
    cleanBibtexField(rawFields.shorttitle || csl?.['title-short']) || undefined;
  const journalAbbr =
    cleanBibtexField(
      rawFields.shortjournal ||
        rawFields.fjournal ||
        csl?.['container-title-short'],
    ) || undefined;
  const pmid = cleanBibtexField(rawFields.pmid || csl?.PMID) || undefined;
  const pmcid = cleanBibtexField(rawFields.pmcid || csl?.PMCID) || undefined;
  const accessedAt =
    cleanBibtexField(rawFields.urldate || rawFields.accessed) || undefined;

  return {
    citationKey: citationKey || undefined,
    itemType,
    title: rawTitle || 'Untitled Reference',
    shortTitle,
    authors,
    editors: editors.length > 0 ? editors : undefined,
    creators: creators.length > 0 ? creators : undefined,
    year,
    publicationDate: rawFields.date || (year ? String(year) : undefined),
    journal: containerTitle,
    journalAbbr,
    publisher,
    university,
    institution,
    thesisType,
    reportNumber,
    reportType,
    bookTitle,
    proceedingsTitle,
    conferenceName,
    eventPlace,
    place,
    volume: csl?.volume ? String(csl.volume) : rawFields.volume || undefined,
    issue:
      itemType === 'report'
        ? rawFields.issue || undefined
        : csl?.issue
          ? String(csl.issue)
          : rawFields.number || rawFields.issue || undefined,
    pages: csl?.page ? String(csl.page) : rawFields.pages || undefined,
    numPages,
    numberOfVolumes,
    seriesNumber,
    chapter,
    doi: normalizedDoi,
    pmid,
    pmcid,
    isbn: csl?.ISBN || rawFields.isbn || undefined,
    issn: csl?.ISSN || rawFields.issn || undefined,
    url: csl?.URL || rawFields.url || undefined,
    accessedAt,
    abstract:
      cleanBibtexField(csl?.abstract || rawFields.abstract) || undefined,
    series:
      cleanBibtexField(
        csl?.['collection-title'] || rawFields.series || rawFields.series_title,
      ) || undefined,
    edition: csl?.edition
      ? String(csl.edition).trim()
      : rawFields.edition || undefined,
    keywords,
    tags: keywords,
    notes: notes && notes.length > 0 ? notes : undefined,
    language: csl?.language
      ? String(csl.language).trim()
      : rawFields.language || undefined,
    rights: csl?.rights
      ? String(csl.rights).trim()
      : rawFields.rights || rawFields.license || undefined,
    fileUrl,
    arxivId: rawArxiv,
  };
}
