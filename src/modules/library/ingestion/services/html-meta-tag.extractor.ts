import { Injectable } from '@nestjs/common';
import {
  cleanAbstractText,
  cleanBibliographicText,
  decodeHtmlEntities,
  deriveDoiFromPublisherUrl,
  extractYearFromDate,
  normalizeArxivId,
  normalizeDoi,
  normalizeIsbn,
  normalizeIssn,
  normalizePmcid,
  normalizePmid,
  parseCreatorString,
  splitAuthorString,
} from '@/modules/library/core';
import { PublisherDomExtractor } from './publisher-dom.extractor';

export interface ScrapedCreator {
  firstName?: string;
  lastName: string;
  fullName?: string;
  creatorType?: string;
  fieldMode?: number;
}

export interface ScrapedUrlResult {
  url: string;
  isPdf: boolean;
  fileBuffer?: Buffer;
  filename?: string;
  fileId?: string;
  title?: string;
  shortTitle?: string;
  authors?: string[];
  creators?: ScrapedCreator[];
  doi?: string;
  arxivId?: string;
  pmid?: string;
  pmcid?: string;
  isbn?: string;
  issn?: string;
  year?: number;
  publicationDate?: string;
  publicationTitle?: string;
  journal?: string;
  journalAbbr?: string;
  publisher?: string;
  abstract?: string;
  keywords?: string[];
  pdfUrl?: string;
  /** Journal / periodical volume (citation_volume, prism.volume, …) */
  volume?: string;
  /** Journal issue / number (citation_issue, prism.number, …) */
  issue?: string;
  /** Page range "first-last" or single page */
  pages?: string;
  /** Language code/name as published (citation_language, dc.language, …) */
  language?: string;
  /** Place of publication (maps to Zotero `place`) */
  publisherPlace?: string;
  place?: string;
  /** Conference / proceedings name (citation_conference_title) */
  conferenceName?: string;
  proceedingsTitle?: string;
  /** Containing book title for chapters (citation_inbook_title) */
  bookTitle?: string;
  series?: string;
  edition?: string;
  rights?: string;
  /** Degree-granting / report-issuing institution */
  institution?: string;
  university?: string;
  thesisType?: string;
  /** Report / technical report number */
  reportNumber?: string;
  /**
   * Zotero item type hint derived from embedded metadata
   * (journalArticle | conferencePaper | bookSection | book | thesis | report |
   *  newspaperArticle | blogPost | dataset). Hint only — callers decide.
   */
  itemType?: string;
  confidence: number;
  isBlocked?: boolean;
  wafKind?: string;
  promptUploadPdf?: boolean;
  ladderStepReached?: number;
}

export interface MetaEntry {
  key: string;
  value: string;
  alias: boolean;
}

@Injectable()
export class HtmlMetaTagExtractor {
  constructor(
    private readonly publisherDomExtractor: PublisherDomExtractor = new PublisherDomExtractor(),
  ) {}

  extractHtmlMetadata(
    html: string,
    pageUrl: string,
  ): Partial<ScrapedUrlResult> {
    const entries = this.parseMetaEntries(html);
    const metaTags = this.buildMetaMap(entries);
    const all = (...keys: string[]) => this.collectMetaValues(entries, keys);
    const first = (...keys: string[]): string | undefined => {
      for (const k of keys) {
        const v = metaTags[k];
        if (v && v.trim()) return v.trim();
      }
      return undefined;
    };
    const jsonLd = this.publisherDomExtractor.extractJsonLdMetadata(html);
    const coins = this.publisherDomExtractor.extractCoinsMetadata(html);
    const result: Partial<ScrapedUrlResult> = {};

    let rawTitle =
      first('citation_title', 'eprints.title', 'dc.title', 'dcterms.title') ||
      jsonLd.title ||
      coins.title ||
      first('og:title', 'twitter:title');
    if (!rawTitle) {
      const titleTagMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      if (titleTagMatch && titleTagMatch[1]) {
        let cleanTag = decodeHtmlEntities(titleTagMatch[1]).trim();
        cleanTag = this.publisherDomExtractor.cleanPublisherTitle(cleanTag);
        if (cleanTag.length >= 3) {
          rawTitle = cleanTag;
        }
      }
    }

    if (rawTitle) {
      result.title = cleanBibliographicText(rawTitle) || rawTitle;
      const shortMatch = result.title.match(/^([^:?]+?)\s*[:?]\s+\S/);
      if (shortMatch && shortMatch[1].trim().length >= 3) {
        result.shortTitle = shortMatch[1].trim();
      }
    }

    let rawAuthors = all('citation_author');
    if (rawAuthors.length === 0) rawAuthors = all('citation_authors');
    if (rawAuthors.length === 0) rawAuthors = all('eprints.creators_name');
    if (rawAuthors.length === 0) {
      rawAuthors = all('dc.creator', 'dcterms.creator');
    }
    let usedJsonLdAuthors = false;
    if (rawAuthors.length === 0 && jsonLd.authors?.length) {
      rawAuthors = jsonLd.authors;
      usedJsonLdAuthors = true;
    }
    if (rawAuthors.length === 0 && coins.authors?.length) {
      rawAuthors = coins.authors;
    }
    const authors = this.dedupeNames(rawAuthors);
    const editors = this.dedupeNames(
      all('citation_editor', 'eprints.editors_name'),
    );
    if (authors.length > 0) {
      result.authors = authors;
    }
    const authorCreators =
      usedJsonLdAuthors && jsonLd.creators?.length
        ? jsonLd.creators
        : authors.map((a, idx) => this.toCreator(a, idx, 'author'));
    const creators = [
      ...authorCreators,
      ...editors.map((e, idx) => this.toCreator(e, idx, 'editor')),
    ];
    if (creators.length > 0) {
      result.creators = creators;
    }

    for (const cand of [
      first('citation_doi'),
      first('prism.doi'),
      ...all('dc.identifier', 'dcterms.identifier', 'eprints.id_number'),
      jsonLd.doi,
      coins.doi,
    ]) {
      const d = cand ? normalizeDoi(cand) : undefined;
      if (d) {
        result.doi = d;
        break;
      }
    }
    if (!result.doi) {
      const urlDoi = deriveDoiFromPublisherUrl(pageUrl);
      if (urlDoi) result.doi = urlDoi;
    }
    if (!result.doi) {
      const counts = new Map<string, number>();
      const doiRe = /\b(10\.\d{4,9}\/[-._;()/:A-Za-z0-9<>+=[\]~]+)\b/gi;
      let m: RegExpExecArray | null;
      while ((m = doiRe.exec(html)) !== null) {
        if (m[1].includes('schema.org')) continue;
        const d = normalizeDoi(m[1]);
        if (d) counts.set(d, (counts.get(d) || 0) + 1);
      }
      let best: string | undefined;
      let bestCount = 0;
      for (const [d, c] of counts) {
        if (c > bestCount) {
          best = d;
          bestCount = c;
        }
      }
      if (best && bestCount >= 2) {
        result.doi = best;
      }
    }

    const rawArxiv = first('citation_arxiv_id');
    if (rawArxiv) {
      result.arxivId = normalizeArxivId(rawArxiv);
    }

    const rawPmid = first('citation_pmid');
    if (rawPmid) {
      result.pmid = normalizePmid(rawPmid);
    }

    for (const cand of [
      first('citation_pmcid', 'prism.pmcid'),
      ...all('dc.identifier', 'dcterms.identifier', 'eprints.id_number'),
    ]) {
      const pmc = cand ? normalizePmcid(cand) : undefined;
      if (pmc) {
        result.pmcid = pmc;
        break;
      }
    }

    for (const cand of [
      ...all(
        'citation_issn',
        'citation_eissn',
        'prism.issn',
        'prism.eissn',
        'eprints.issn',
      ),
      jsonLd.issn,
      coins.issn,
    ]) {
      const v = cand ? normalizeIssn(cand) : undefined;
      if (v) {
        result.issn = v;
        break;
      }
    }

    for (const cand of [
      ...all('citation_isbn', 'prism.isbn', 'eprints.isbn'),
      jsonLd.isbn,
      coins.isbn,
    ]) {
      const v = cand ? normalizeIsbn(cand) : undefined;
      if (v) {
        result.isbn = v;
        break;
      }
    }

    const rawDate =
      first(
        'citation_publication_date',
        'citation_date',
        'citation_cover_date',
        'prism.publicationdate',
        'prism.coverdate',
        'dc.date',
        'dcterms.issued',
        'dcterms.date',
        'eprints.date',
        'citation_online_date',
        'prism.onlinedate',
      ) ||
      jsonLd.date ||
      coins.date;
    if (rawDate) {
      result.publicationDate = rawDate.trim();
      result.year = extractYearFromDate(rawDate);
    } else {
      const urlDateMatch = pageUrl.match(
        /(?:^|\/)((?:19|20)\d{2})[-/](0[1-9]|1[0-2])[-/](0[1-9]|[12]\d|3[01])(?:\/|[?#]|$)/,
      );
      if (urlDateMatch) {
        result.publicationDate = `${urlDateMatch[1]}-${urlDateMatch[2]}-${urlDateMatch[3]}`;
        result.year = parseInt(urlDateMatch[1], 10);
      }
    }

    const journalTitle = this.cleanText(
      first(
        'citation_journal_title',
        'prism.publicationname',
        'eprints.publication',
        'dc.source',
      ),
    );
    const journalAbbr = this.cleanText(
      first(
        'citation_journal_abbrev',
        'citation_journal_abbreviation',
        'prism.alternateTitle',
      ),
    );
    if (journalAbbr) result.journalAbbr = journalAbbr;

    const conferenceName = this.cleanText(
      first(
        'citation_conference_title',
        'citation_conference',
        'eprints.event_title',
      ),
    );
    const bookTitle = this.cleanText(
      first(
        'citation_inbook_title',
        'citation_book_title',
        'eprints.book_title',
      ),
    );
    const seriesTitle = this.cleanText(
      first('citation_series_title', 'eprints.series'),
    );
    if (seriesTitle) result.series = seriesTitle;

    const edition = this.cleanText(
      first('citation_edition', 'prism.edition', 'eprints.edition'),
    );
    if (edition) result.edition = edition;

    const rights = this.cleanText(
      first(
        'dc.rights',
        'dcterms.rights',
        'dcterms.license',
        'prism.copyright',
      ),
    );
    if (rights) result.rights = rights;

    const fallbackVenue = this.cleanText(
      jsonLd.publicationTitle || coins.publicationTitle,
    );
    if (conferenceName) result.conferenceName = conferenceName;
    if (bookTitle) result.bookTitle = bookTitle;

    const venue =
      journalTitle ||
      conferenceName ||
      bookTitle ||
      seriesTitle ||
      fallbackVenue;
    if (venue) {
      result.publicationTitle = venue;
      if (venue !== bookTitle) result.journal = venue;
    }

    const pub = first(
      'citation_publisher',
      'dc.publisher',
      'dcterms.publisher',
      'eprints.publisher',
      'prism.publisher',
    );
    const cleanPub = this.cleanText(pub || jsonLd.publisher);
    if (cleanPub) {
      result.publisher = cleanPub;
    }
    const place = this.cleanText(
      first(
        'citation_publisher_place',
        'citation_publication_place',
        'citation_place',
        'eprints.place_of_pub',
      ),
    );
    if (place) {
      result.publisherPlace = place;
      result.place = place;
    }

    const thesisInstitution = this.cleanText(
      first('citation_dissertation_institution'),
    );
    const thesisType = this.cleanText(
      first(
        'citation_dissertation_name',
        'citation_thesis_type',
        'eprints.thesis_type',
      ),
    );
    if (thesisType) result.thesisType = thesisType;

    const reportInstitution = this.cleanText(
      first('citation_technical_report_institution'),
    );
    const eprintsInstitution = this.cleanText(first('eprints.institution'));
    const institution =
      thesisInstitution || reportInstitution || eprintsInstitution;
    if (institution) result.institution = institution;
    if (thesisInstitution) result.university = thesisInstitution;
    const reportNumber = first(
      'citation_technical_report_number',
      'eprints.number_report',
    );
    if (reportNumber) result.reportNumber = reportNumber;

    const volume =
      first('citation_volume', 'prism.volume', 'eprints.volume') ||
      jsonLd.volume ||
      coins.volume;
    if (volume) result.volume = volume;

    const issue =
      first(
        'citation_issue',
        'prism.number',
        'prism.issueidentifier',
        'eprints.number',
      ) ||
      jsonLd.issue ||
      coins.issue;
    if (issue) result.issue = issue;

    const pages =
      this.joinPages(first('citation_firstpage'), first('citation_lastpage')) ||
      this.joinPages(first('prism.startingpage'), first('prism.endingpage')) ||
      first('prism.pagerange', 'eprints.pagerange') ||
      jsonLd.pages ||
      coins.pages;
    if (pages) result.pages = pages;

    const language =
      first(
        'citation_language',
        'dc.language',
        'dcterms.language',
        'eprints.language',
      ) || jsonLd.language;
    if (language) result.language = language;

    const eprintsType = (first('eprints.type') || '').toLowerCase();
    if (thesisInstitution || thesisType || eprintsType === 'thesis') {
      result.itemType = 'thesis';
      if (!result.university && result.institution) {
        result.university = result.institution;
      }
    } else if (
      reportInstitution ||
      reportNumber ||
      eprintsType === 'monograph'
    ) {
      result.itemType = 'report';
    } else if (conferenceName || eprintsType === 'conference_item') {
      result.itemType = 'conferencePaper';
      result.proceedingsTitle = journalTitle || conferenceName || venue;
    } else if (bookTitle || eprintsType === 'book_section') {
      result.itemType = 'bookSection';
    } else if (journalTitle || eprintsType === 'article') {
      result.itemType = 'journalArticle';
    } else if (eprprintsTypeMatch(eprintsType)) {
      result.itemType = 'book';
    } else if (jsonLd.itemType) {
      result.itemType = jsonLd.itemType;
    } else if (coins.itemType) {
      result.itemType = coins.itemType;
    } else if (/\/blogs?\//i.test(pageUrl)) {
      result.itemType = 'blogPost';
    }

    const pdfUrl = first(
      'citation_pdf_url',
      'citation_fulltext_html_url',
      'eprints.document_url',
      'bepress_citation_pdf_url',
    );
    if (pdfUrl) {
      try {
        result.pdfUrl = new URL(pdfUrl, pageUrl).toString();
      } catch {
        result.pdfUrl = pdfUrl;
      }
    }

    let rawAbstract =
      first(
        'citation_abstract',
        'eprints.abstract',
        'dcterms.abstract',
        'dc.description',
      ) ||
      jsonLd.abstract ||
      coins.abstract;
    if (!rawAbstract) {
      const og = first('og:description');
      if (og && og.length >= 200) rawAbstract = og;
    }
    if (rawAbstract) {
      const cleanedAbstract = cleanAbstractText(rawAbstract);
      if (cleanedAbstract) result.abstract = cleanedAbstract;
    }

    let keywordValues = all('citation_keywords', 'citation_keyword');
    if (keywordValues.length === 0) {
      keywordValues = all('eprints.keywords', 'dc.subject', 'dcterms.subject');
    }
    if (keywordValues.length === 0 && jsonLd.keywords?.length) {
      keywordValues = jsonLd.keywords;
    }
    let keywords = this.splitKeywords(keywordValues);
    if (keywords.length === 0) {
      const generic = this.splitKeywords(all('keywords'));
      if (this.looksLikeKeywordList(generic)) keywords = generic;
    }
    if (keywords.length > 0) {
      result.keywords = keywords;
    }

    return result;
  }

  cleanText(v?: string): string | undefined {
    if (!v) return undefined;
    return cleanBibliographicText(v) || undefined;
  }

  joinPages(firstPage?: string, lastPage?: string): string | undefined {
    const f = firstPage?.trim();
    const l = lastPage?.trim();
    if (!f) return undefined;
    if (/[-–]/.test(f) || !l || l === f) return f;
    return `${f}-${l}`;
  }

  dedupeNames(raw: string[]): string[] {
    const seen = new Set<string>();
    return raw
      .flatMap((a) => splitAuthorString(a))
      .filter((a) => {
        const key = a.toLowerCase().replace(/\s+/g, ' ').trim();
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }

  toCreator(name: string, idx: number, creatorType: string): ScrapedCreator {
    const parsed = parseCreatorString(name, idx, creatorType);
    return {
      firstName: parsed.firstName,
      lastName: parsed.lastName,
      fullName: parsed.fullName,
      creatorType,
      ...(parsed.fieldMode === 1 ? { fieldMode: 1 } : {}),
    };
  }

  splitKeywords(values: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const v of values) {
      for (const k of v.split(/[,;]/)) {
        const t = k.trim();
        const key = t.toLowerCase();
        if (t && !seen.has(key)) {
          seen.add(key);
          out.push(t);
        }
      }
    }
    return out;
  }

  looksLikeKeywordList(items: string[]): boolean {
    if (items.length < 2 || items.length > 30) return false;
    return items.every(
      (k) => k.length <= 60 && k.split(/\s+/).length <= 6 && !/[.!?]$/.test(k),
    );
  }

  parseMetaEntries(html: string): MetaEntry[] {
    const entries: MetaEntry[] = [];
    const tagRe = /<meta\b((?:"[^"]*"|'[^']*'|[^'">])*)>/gi;
    let tagMatch: RegExpExecArray | null;

    while ((tagMatch = tagRe.exec(html)) !== null) {
      const attrs = this.parseAttributes(tagMatch[1]);
      const content = attrs['content'];
      if (content === undefined) continue;
      const value = decodeHtmlEntities(content).trim();
      if (!value) continue;

      for (const attrName of ['name', 'property', 'itemprop']) {
        const rawKey = attrs[attrName];
        if (!rawKey) continue;
        for (const k of rawKey.split(/\s+/).filter(Boolean)) {
          let key = k.trim().toLowerCase();
          key = key.replace(/^(dc|dcterms|prism|eprints):/, '$1.');
          if (key.startsWith('bepress_citation_')) {
            entries.push({ key, value, alias: false });
            entries.push({
              key: key.replace(/^bepress_/, ''),
              value,
              alias: true,
            });
          } else {
            entries.push({ key, value, alias: false });
          }
        }
      }
    }
    return entries;
  }

  parseAttributes(attrText: string): Record<string, string> {
    const attrs: Record<string, string> = {};
    const attrRe = /([a-zA-Z_:.-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g;
    let m: RegExpExecArray | null;
    while ((m = attrRe.exec(attrText)) !== null) {
      const name = m[1].toLowerCase();
      if (attrs[name] !== undefined) continue;
      attrs[name] = m[3] ?? m[4] ?? m[5] ?? '';
    }
    return attrs;
  }

  buildMetaMap(entries: MetaEntry[]): Record<string, string> {
    const map: Record<string, string> = {};
    for (const pass of [false, true]) {
      for (const e of entries) {
        if (e.alias === pass && !map[e.key]) map[e.key] = e.value;
      }
    }
    return map;
  }

  collectMetaValues(entries: MetaEntry[], keys: string[]): string[] {
    const targets = new Set(keys.map((k) => k.toLowerCase()));
    const native = entries.filter((e) => !e.alias && targets.has(e.key));
    if (native.length > 0) return native.map((e) => e.value);
    return entries
      .filter((e) => e.alias && targets.has(e.key))
      .map((e) => e.value);
  }
}

function eprprintsTypeMatch(t: string): boolean {
  return t === 'book';
}
