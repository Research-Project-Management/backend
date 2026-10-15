import { Injectable, Logger } from '@nestjs/common';
import {
  stripLatexBraces,
  normalizeDoi,
  parseCreatorString,
} from '@/modules/library/shared-kernel/domain/bibliographic.domain';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Cite } = require('@citation-js/core');
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('@citation-js/plugin-bibtex');

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

interface CslPerson {
  literal?: string;
  given?: string;
  family?: string;
}

interface CslItem {
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

@Injectable()
export class BibtexParser {
  private readonly logger = new Logger(BibtexParser.name);

  /**
   * Parse a raw BibTeX string asynchronously using in-process @citation-js.
   */
  async parseAsync(rawBibtex: string): Promise<ParsedBibtexEntry[]> {
    if (!rawBibtex || typeof rawBibtex !== 'string' || !rawBibtex.trim()) {
      return [];
    }
    return this.parse(rawBibtex);
  }

  /**
   * Splits a raw BibTeX author/editor field on top-level `and` while detecting
   * brace-protected corporate/institutional names like `{World Health Organization}`.
   */
  private extractStructuredBibtexPersons(
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
    for (let i = 0; i < str.length; i++) {
      if (str[i] === '\\') {
        i++;
        continue;
      }
      if (str[i] === '{') depth++;
      else if (str[i] === '}') depth = Math.max(0, depth - 1);
      else if (depth === 0) {
        const sub = str.slice(i);
        const andMatch = sub.match(/^\s+and\s+/i);
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
      const cleaned = this.cleanBibtexField(token);
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

  /**
   * Parse a raw BibTeX string containing one or multiple entries using @citation-js engine.
   */
  parse(rawBibtex: string): ParsedBibtexEntry[] {
    if (!rawBibtex || typeof rawBibtex !== 'string' || !rawBibtex.trim()) {
      return [];
    }

    try {
      const cite = new Cite(rawBibtex);
      const data: CslItem[] = (cite.data as CslItem[]) || [];

      // Pre-scan raw BibTeX entries by citationKey and index so we can enrich fields
      // that @citation-js/plugin-bibtex drops (e.g. eprint, archivePrefix, file, raw entry type).
      const rawEntriesByKey = new Map<
        string,
        { rawType: string; fields: Record<string, string> }
      >();
      const rawEntriesByIndex: Array<{
        rawType: string;
        citationKey: string;
        fields: Record<string, string>;
      }> = [];
      const entryRegex =
        /@([a-zA-Z]+)\s*\{\s*([^,\s]*)\s*,([\s\S]*?)(?=\n\s*@[a-zA-Z]+\s*\{|\s*$)/g;
      let rawMatch: RegExpExecArray | null;
      while ((rawMatch = entryRegex.exec(rawBibtex)) !== null) {
        const rType = rawMatch[1].toLowerCase();
        if (rType === 'comment' || rType === 'preamble' || rType === 'string') {
          continue;
        }
        const cKey = rawMatch[2]?.trim() || '';
        const extractedFields = this.extractBibtexFields(rawMatch[3] || '');
        const entryInfo = {
          rawType: rType,
          citationKey: cKey,
          fields: extractedFields,
        };
        rawEntriesByIndex.push(entryInfo);
        if (cKey) {
          rawEntriesByKey.set(cKey.toLowerCase(), entryInfo);
        }
      }

      const isOthersToken = (name: string) =>
        /^(?:others|and\s+others|et\s+al\.?)$/i.test(name.trim());

      return data.map((csl: CslItem, idx: number) => {
        const citationKey = csl['citation-key'] || csl.id || undefined;
        const rawEntry =
          (citationKey
            ? rawEntriesByKey.get(String(citationKey).toLowerCase())
            : undefined) || rawEntriesByIndex[idx];
        const rawFields = rawEntry?.fields || {};
        const entryTypeLower = (rawEntry?.rawType || '').toLowerCase();

        // Authors formatting: preserve author strings "Given Family" or "Family, Given"
        const structuredRawAuthors = this.extractStructuredBibtexPersons(
          rawFields.author,
          'author',
        );
        const structuredRawEditors = this.extractStructuredBibtexPersons(
          rawFields.editor,
          'editor',
        );

        const authors: string[] =
          structuredRawAuthors.length > 0
            ? structuredRawAuthors.map((a) => a.fullName)
            : (csl.author || [])
                .map((a: CslPerson) => {
                  if (a.literal) return this.cleanBibtexField(a.literal);
                  if (a.given && a.family)
                    return this.cleanBibtexField(`${a.given} ${a.family}`);
                  return this.cleanBibtexField(a.family || a.given || '');
                })
                .filter((name) => Boolean(name) && !isOthersToken(name));

        const editors: string[] =
          structuredRawEditors.length > 0
            ? structuredRawEditors.map((e) => e.fullName)
            : (csl.editor || [])
                .map((e: CslPerson) => {
                  if (e.literal) return this.cleanBibtexField(e.literal);
                  if (e.given && e.family)
                    return this.cleanBibtexField(`${e.given} ${e.family}`);
                  return this.cleanBibtexField(e.family || e.given || '');
                })
                .filter((name) => Boolean(name) && !isOthersToken(name));

        const creators = [
          ...(structuredRawAuthors.length > 0
            ? structuredRawAuthors
            : (csl.author || [])
                .map((a: CslPerson) => {
                  if (a.literal && !a.given && !a.family) {
                    const cleanLit = this.cleanBibtexField(a.literal);
                    return cleanLit && !isOthersToken(cleanLit)
                      ? {
                          name: cleanLit,
                          fullName: cleanLit,
                          firstName: '',
                          lastName: cleanLit,
                          creatorType: 'author',
                          fieldMode: 1,
                        }
                      : null;
                  }
                  const given = this.cleanBibtexField(a.given);
                  const family = this.cleanBibtexField(a.family);
                  const full = [given, family].filter(Boolean).join(' ');
                  return full && !isOthersToken(full)
                    ? {
                        name: full,
                        fullName: full,
                        firstName: given,
                        lastName: family,
                        creatorType: 'author',
                        fieldMode: 0,
                      }
                    : null;
                })
                .filter((x): x is NonNullable<typeof x> => x !== null)),
          ...(structuredRawEditors.length > 0
            ? structuredRawEditors
            : (csl.editor || [])
                .map((e: CslPerson) => {
                  if (e.literal && !e.given && !e.family) {
                    const cleanLit = this.cleanBibtexField(e.literal);
                    return cleanLit && !isOthersToken(cleanLit)
                      ? {
                          name: cleanLit,
                          fullName: cleanLit,
                          firstName: '',
                          lastName: cleanLit,
                          creatorType: 'editor',
                          fieldMode: 1,
                        }
                      : null;
                  }
                  const given = this.cleanBibtexField(e.given);
                  const family = this.cleanBibtexField(e.family);
                  const full = [given, family].filter(Boolean).join(' ');
                  return full && !isOthersToken(full)
                    ? {
                        name: full,
                        fullName: full,
                        firstName: given,
                        lastName: family,
                        creatorType: 'editor',
                        fieldMode: 0,
                      }
                    : null;
                })
                .filter((x): x is NonNullable<typeof x> => x !== null)),
        ];

        const year =
          csl.issued?.['date-parts']?.[0]?.[0] != null
            ? Number(csl.issued['date-parts'][0][0])
            : rawFields.year
              ? parseInt(rawFields.year, 10) || null
              : rawFields.date
                ? parseInt(rawFields.date.slice(0, 4), 10) || null
                : null;

        const rawArxiv =
          csl.arXiv ||
          csl.arxiv ||
          rawFields.eprint ||
          rawFields.arxiv ||
          rawFields.arxivid ||
          (typeof csl.id === 'string' &&
          csl.id.match(/^(\d{4}\.\d{4,5}(?:v\d+)?)$/)?.[1]
            ? csl.id
            : undefined);
        const isArxivPreprint =
          Boolean(rawArxiv) &&
          (!rawFields.archiveprefix ||
            rawFields.archiveprefix.toLowerCase() === 'arxiv');

        let itemType = rawEntry?.rawType
          ? this.mapBibtexTypeToItemType(rawEntry.rawType)
          : this.mapCslTypeToItemType(csl.type || 'article-journal');
        if (
          isArxivPreprint &&
          (itemType === 'webpage' ||
            itemType === 'manuscript' ||
            rawEntry?.rawType === 'online' ||
            rawEntry?.rawType === 'misc' ||
            rawEntry?.rawType === 'unpublished')
        ) {
          itemType = 'preprint';
        }

        // Tags / keywords extraction
        const rawKeywords =
          csl.keyword ||
          csl.keywords ||
          csl.subject ||
          rawFields.keywords ||
          rawFields.keyword ||
          rawFields.tags;
        let keywords: string[] | undefined;
        if (Array.isArray(rawKeywords)) {
          keywords = rawKeywords
            .map((k: unknown) => this.cleanBibtexField(String(k)))
            .filter(Boolean);
        } else if (typeof rawKeywords === 'string' && rawKeywords.trim()) {
          keywords = rawKeywords
            .split(/[,;\n]/)
            .map((k: string) => this.cleanBibtexField(k))
            .filter(Boolean);
        }

        // Notes / annotations / comments extraction
        const rawNotes =
          csl.note ||
          csl.annote ||
          csl.comment ||
          csl['annote'] ||
          csl['note'] ||
          rawFields.note ||
          rawFields.annote ||
          rawFields.comment;
        let notes: string[] | undefined;
        if (Array.isArray(rawNotes)) {
          notes = rawNotes
            .map((n: unknown) => this.cleanBibtexField(String(n)))
            .filter(Boolean);
        } else if (typeof rawNotes === 'string' && rawNotes.trim()) {
          notes = [this.cleanBibtexField(rawNotes)];
        }

        let fileUrl: string | undefined;
        const rawFile = rawFields.file || rawFields.pdf;
        if (rawFile) {
          const cleanFile = rawFile.replace(/^:([^:]+):.*$/, '$1').trim();
          if (cleanFile) fileUrl = cleanFile;
        }

        const rawDoi = csl.DOI || rawFields.doi;
        const normalizedDoi = rawDoi
          ? normalizeDoi(rawDoi) || rawDoi
          : undefined;

        const rawTitle = rawFields.title
          ? this.cleanBibtexField(rawFields.title)
          : this.cleanBibtexField(csl.title);

        const university =
          this.cleanBibtexField(rawFields.school || rawFields.university) ||
          (itemType === 'thesis'
            ? this.cleanBibtexField(csl.publisher) || undefined
            : undefined);
        const institution =
          this.cleanBibtexField(
            rawFields.institution || rawFields.organization,
          ) ||
          (itemType === 'report'
            ? this.cleanBibtexField(csl.publisher) || undefined
            : undefined);

        const publisher =
          this.cleanBibtexField(csl.publisher || rawFields.publisher) ||
          university ||
          institution ||
          undefined;

        const thesisType =
          itemType === 'thesis'
            ? this.cleanBibtexField(rawFields.type) ||
              (entryTypeLower === 'phdthesis'
                ? 'PhD thesis'
                : entryTypeLower === 'mastersthesis'
                  ? "Master's thesis"
                  : undefined)
            : undefined;

        const reportType =
          itemType === 'report'
            ? this.cleanBibtexField(rawFields.type) || undefined
            : undefined;
        const reportNumber =
          itemType === 'report'
            ? this.cleanBibtexField(
                rawFields.number ||
                  (csl.number != null ? String(csl.number) : undefined),
              ) || undefined
            : undefined;

        const containerTitle =
          this.cleanBibtexField(
            csl['container-title'] ||
              rawFields.journal ||
              rawFields.journaltitle ||
              rawFields.booktitle,
          ) || undefined;

        const bookTitle =
          itemType === 'bookSection'
            ? this.cleanBibtexField(
                rawFields.booktitle || csl['container-title'],
              ) || undefined
            : undefined;
        const proceedingsTitle =
          itemType === 'conferencePaper'
            ? this.cleanBibtexField(
                rawFields.booktitle || csl['container-title'],
              ) || undefined
            : undefined;
        const conferenceName =
          itemType === 'conferencePaper'
            ? this.cleanBibtexField(
                rawFields.eventtitle || rawFields.conference,
              ) || undefined
            : undefined;
        const eventPlace =
          this.cleanBibtexField(
            rawFields.venue || rawFields.eventplace || rawFields.location,
          ) || undefined;

        const place =
          this.cleanBibtexField(
            csl['publisher-place'] ||
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
            ? this.cleanBibtexField(rawFields.number)
            : csl['collection-number'] != null
              ? String(csl['collection-number'])
              : undefined;

        const numPages =
          this.cleanBibtexField(rawFields.numpages || rawFields.pagetotal) ||
          (csl['number-of-pages'] != null
            ? String(csl['number-of-pages'])
            : undefined);

        const numberOfVolumes =
          this.cleanBibtexField(rawFields.volumes) ||
          (csl['number-of-volumes'] != null
            ? String(csl['number-of-volumes'])
            : undefined);

        const chapter = this.cleanBibtexField(rawFields.chapter) || undefined;

        const shortTitle =
          this.cleanBibtexField(rawFields.shorttitle || csl['title-short']) ||
          undefined;
        const journalAbbr =
          this.cleanBibtexField(
            rawFields.shortjournal ||
              rawFields.fjournal ||
              csl['container-title-short'],
          ) || undefined;
        const pmid =
          this.cleanBibtexField(rawFields.pmid || csl.PMID) || undefined;
        const pmcid =
          this.cleanBibtexField(rawFields.pmcid || csl.PMCID) || undefined;
        const accessedAt =
          this.cleanBibtexField(rawFields.urldate || rawFields.accessed) ||
          undefined;

        return {
          citationKey,
          itemType,
          title: rawTitle || 'Untitled Reference',
          shortTitle,
          authors,
          editors: editors && editors.length > 0 ? editors : undefined,
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
          volume: csl.volume
            ? String(csl.volume)
            : rawFields.volume || undefined,
          issue:
            itemType === 'report'
              ? rawFields.issue || undefined
              : csl.issue
                ? String(csl.issue)
                : rawFields.number || rawFields.issue || undefined,
          pages: csl.page ? String(csl.page) : rawFields.pages || undefined,
          numPages,
          numberOfVolumes,
          seriesNumber,
          chapter,
          doi: normalizedDoi,
          pmid,
          pmcid,
          isbn: csl.ISBN || rawFields.isbn || undefined,
          issn: csl.ISSN || rawFields.issn || undefined,
          url: csl.URL || rawFields.url || undefined,
          accessedAt,
          abstract:
            this.cleanBibtexField(csl.abstract || rawFields.abstract) ||
            undefined,
          series:
            this.cleanBibtexField(
              csl['collection-title'] ||
                rawFields.series ||
                rawFields.series_title,
            ) || undefined,
          edition: csl.edition
            ? String(csl.edition).trim()
            : rawFields.edition || undefined,
          keywords: keywords && keywords.length > 0 ? keywords : undefined,
          notes: notes && notes.length > 0 ? notes : undefined,
          language: csl.language
            ? String(csl.language).trim()
            : rawFields.language || undefined,
          rights: csl.rights
            ? String(csl.rights).trim()
            : rawFields.rights || rawFields.license || undefined,
          fileUrl,
          arxivId: rawArxiv,
        };
      });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Citation.js BibTeX parser error: ${errMsg}. Attempting fallback parsing.`,
      );
      return this.fallbackParse(rawBibtex);
    }
  }

  private mapCslTypeToItemType(cslType: string): string {
    const map: Record<string, string> = {
      'article-journal': 'journalArticle',
      'paper-conference': 'conferencePaper',
      book: 'book',
      chapter: 'bookSection',
      thesis: 'thesis',
      report: 'report',
      webpage: 'webpage',
      patent: 'patent',
      dataset: 'dataset',
      software: 'computerProgram',
    };
    return map[cslType] || 'journalArticle';
  }

  private mapBibtexTypeToItemType(bibtexType: string): string {
    const lower = (bibtexType || '').toLowerCase().trim();
    const map: Record<string, string> = {
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
    return map[lower] || this.mapCslTypeToItemType(lower);
  }

  /**
   * Resilient regex fallback for non-standard BibTeX dialects
   */
  private fallbackParse(rawBibtex: string): ParsedBibtexEntry[] {
    const entries: ParsedBibtexEntry[] = [];
    const entryRegex =
      /@([a-zA-Z]+)\s*\{\s*([^,\s]*)\s*,([\s\S]*?)(?=\n\s*@[a-zA-Z]+\s*\{|\s*$)/g;

    const isOthersToken = (name: string) =>
      /^(?:others|and\s+others|et\s+al\.?)$/i.test(name.trim());

    let match: RegExpExecArray | null;
    while ((match = entryRegex.exec(rawBibtex)) !== null) {
      const rawType = match[1].toLowerCase();
      if (
        rawType === 'comment' ||
        rawType === 'preamble' ||
        rawType === 'string'
      ) {
        continue;
      }

      const citationKey = match[2]?.trim() || '';
      const body = match[3] || '';

      const fields = this.extractBibtexFields(body);

      const structuredAuthors = this.extractStructuredBibtexPersons(
        fields.author,
        'author',
      );
      const structuredEditors = this.extractStructuredBibtexPersons(
        fields.editor,
        'editor',
      );

      const authors = fields.author
        ? fields.author
            .split(/\s+and\s+/i)
            .map((a) => a.trim())
            .filter((a) => Boolean(a) && !isOthersToken(a))
        : [];

      const editors = fields.editor
        ? fields.editor
            .split(/\s+and\s+/i)
            .map((e) => e.trim())
            .filter((e) => Boolean(e) && !isOthersToken(e))
        : [];

      const creators = [...structuredAuthors, ...structuredEditors];

      // Extract keywords / tags
      const rawKeywords = fields.keywords || fields.keyword || fields.tags;
      const keywords = rawKeywords
        ? rawKeywords
            .split(/[,;\n]|\s+[/]\s+/)
            .map((k) => this.cleanBibtexField(k))
            .filter(Boolean)
        : undefined;

      // Extract notes / annote / comment
      const rawNote = fields.note || fields.annote || fields.comment;
      const notes = rawNote ? [this.cleanBibtexField(rawNote)] : undefined;

      // Extract file path from Zotero/Mendeley BibTeX :path/to/file.pdf:PDF format
      let fileUrl: string | undefined;
      const rawFile = fields.file || fields.pdf;
      if (rawFile) {
        const cleanFile = rawFile.replace(/^:([^:]+):.*$/, '$1').trim();
        if (cleanFile) fileUrl = cleanFile;
      }

      const rawArxiv =
        fields.eprint || fields.arxiv || fields.arxivid || undefined;
      const isArxivPreprint =
        Boolean(rawArxiv) &&
        (!fields.archiveprefix ||
          fields.archiveprefix.toLowerCase() === 'arxiv');
      let itemType = this.mapBibtexTypeToItemType(rawType);
      if (
        isArxivPreprint &&
        (itemType === 'webpage' ||
          itemType === 'manuscript' ||
          rawType === 'online' ||
          rawType === 'misc' ||
          rawType === 'unpublished')
      ) {
        itemType = 'preprint';
      }

      const university =
        this.cleanBibtexField(fields.school || fields.university) || undefined;
      const institution =
        this.cleanBibtexField(fields.institution || fields.organization) ||
        undefined;
      const publisher =
        this.cleanBibtexField(fields.publisher) ||
        university ||
        institution ||
        undefined;

      const thesisType =
        itemType === 'thesis'
          ? this.cleanBibtexField(fields.type) ||
            (rawType === 'phdthesis'
              ? 'PhD thesis'
              : rawType === 'mastersthesis'
                ? "Master's thesis"
                : undefined)
          : undefined;
      const reportType =
        itemType === 'report'
          ? this.cleanBibtexField(fields.type) || undefined
          : undefined;
      const reportNumber =
        itemType === 'report'
          ? this.cleanBibtexField(fields.number) || undefined
          : undefined;

      const bookTitle =
        itemType === 'bookSection'
          ? this.cleanBibtexField(fields.booktitle) || undefined
          : undefined;
      const proceedingsTitle =
        itemType === 'conferencePaper'
          ? this.cleanBibtexField(fields.booktitle) || undefined
          : undefined;
      const conferenceName =
        itemType === 'conferencePaper'
          ? this.cleanBibtexField(fields.eventtitle || fields.conference) ||
            undefined
          : undefined;
      const eventPlace =
        this.cleanBibtexField(
          fields.venue || fields.eventplace || fields.location,
        ) || undefined;

      const seriesNumber =
        (itemType === 'book' ||
          itemType === 'bookSection' ||
          itemType === 'conferencePaper') &&
        fields.series &&
        fields.number
          ? this.cleanBibtexField(fields.number)
          : undefined;

      const year = fields.year
        ? parseInt(fields.year, 10) || null
        : fields.date
          ? parseInt(fields.date.slice(0, 4), 10) || null
          : null;

      entries.push({
        citationKey: citationKey || undefined,
        itemType,
        title: this.cleanBibtexField(fields.title) || 'Untitled Reference',
        shortTitle: this.cleanBibtexField(fields.shorttitle) || undefined,
        authors,
        editors: editors.length > 0 ? editors : undefined,
        creators: creators.length > 0 ? creators : undefined,
        year,
        publicationDate: fields.date || (year ? String(year) : undefined),
        journal:
          this.cleanBibtexField(
            fields.journal || fields.journaltitle || fields.booktitle,
          ) || undefined,
        journalAbbr:
          this.cleanBibtexField(fields.shortjournal || fields.fjournal) ||
          undefined,
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
        place:
          this.cleanBibtexField(
            fields.address || fields.place || fields.location || fields.venue,
          ) || undefined,
        volume: fields.volume,
        issue:
          itemType === 'report'
            ? fields.issue || undefined
            : fields.number || fields.issue,
        pages: fields.pages,
        numPages:
          this.cleanBibtexField(fields.numpages || fields.pagetotal) ||
          undefined,
        numberOfVolumes: this.cleanBibtexField(fields.volumes) || undefined,
        seriesNumber,
        chapter: this.cleanBibtexField(fields.chapter) || undefined,
        doi: fields.doi ? normalizeDoi(fields.doi) || fields.doi : undefined,
        pmid: this.cleanBibtexField(fields.pmid) || undefined,
        pmcid: this.cleanBibtexField(fields.pmcid) || undefined,
        isbn: fields.isbn,
        issn: fields.issn,
        url: fields.url,
        accessedAt:
          this.cleanBibtexField(fields.urldate || fields.accessed) || undefined,
        abstract: this.cleanBibtexField(fields.abstract) || undefined,
        series:
          this.cleanBibtexField(fields.series || fields.series_title) ||
          undefined,
        edition: fields.edition || undefined,
        keywords,
        notes,
        language: fields.language || undefined,
        rights: fields.rights || fields.license || undefined,
        fileUrl,
        arxivId: rawArxiv,
      });
    }

    return entries;
  }

  /**
   * Helper to clean LaTeX protection braces, decode LaTeX accents, and normalize whitespace.
   */
  private cleanBibtexField(text?: string): string {
    if (!text) return '';
    return stripLatexBraces(text).replace(/\s+/g, ' ').trim();
  }

  /**
   * Resilient character scanner for BibTeX entry body.
   * Handles nested braces (e.g. {Deep Learning with {Attention} Mechanisms}),
   * escaped characters, and quoted string fields without truncated splits.
   */
  private extractBibtexFields(body: string): Record<string, string> {
    const fields: Record<string, string> = {};
    let pos = 0;
    const len = body.length;

    while (pos < len) {
      const keyMatch = body.slice(pos).match(/^\s*([a-zA-Z_-]+)\s*=\s*/);
      if (!keyMatch) {
        pos++;
        continue;
      }

      const key = keyMatch[1].toLowerCase();
      pos += keyMatch[0].length;

      if (pos >= len) break;

      const char = body[pos];
      let value = '';

      if (char === '{') {
        pos++;
        let depth = 1;
        const start = pos;
        while (pos < len && depth > 0) {
          if (body[pos] === '\\') {
            pos += 2;
            continue;
          }
          if (body[pos] === '{') depth++;
          else if (body[pos] === '}') depth--;
          pos++;
        }
        value = body.slice(start, depth === 0 ? pos - 1 : pos);
      } else if (char === '"') {
        pos++;
        const start = pos;
        while (pos < len && body[pos] !== '"') {
          if (body[pos] === '\\') {
            pos += 2;
            continue;
          }
          pos++;
        }
        value = body.slice(start, pos);
        if (pos < len && body[pos] === '"') pos++;
      } else {
        const bareMatch = body.slice(pos).match(/^([^,\n}\s]+)/);
        if (bareMatch) {
          value = bareMatch[1];
          pos += bareMatch[0].length;
        }
      }

      fields[key] = value.trim();

      const commaMatch = body.slice(pos).match(/^\s*,\s*/);
      if (commaMatch) {
        pos += commaMatch[0].length;
      }
    }

    return fields;
  }
}
