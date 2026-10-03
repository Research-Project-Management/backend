/**
 * citations/core/adapters/resolver/crossref-arxiv.resolver.ts
 * Adapter resolving DOI and arXiv identifiers via public academic APIs
 * (CrossRef Content Negotiation & arXiv Atom Export API).
 */

import { IIdentifierResolverPort } from '../../ports/identifier-resolver.port';
import { AcademicIdentifierVo } from '../../domain/value-objects/academic-identifier.vo';
import { BibEntry } from '../../domain/entities/bib-entry.entity';
import { RegexAstBibtexParser } from '../parser/regex-ast-bibtex.parser';
import { sanitizeCitationKey } from '../../domain/utils/bibtex-value.utils';

/** CrossRef work type -> BibTeX entry type + container field. */
const CROSSREF_TYPE_MAP: Record<string, { type: string; container?: string }> =
  {
    'journal-article': { type: 'article', container: 'journal' },
    'proceedings-article': { type: 'inproceedings', container: 'booktitle' },
    'book-chapter': { type: 'incollection', container: 'booktitle' },
    'book-part': { type: 'incollection', container: 'booktitle' },
    'book-section': { type: 'incollection', container: 'booktitle' },
    book: { type: 'book' },
    monograph: { type: 'book' },
    'edited-book': { type: 'book' },
    'reference-book': { type: 'book' },
    report: { type: 'techreport' },
    dissertation: { type: 'phdthesis' },
    'posted-content': { type: 'misc', container: 'howpublished' },
  };

export class CrossrefArxivResolverAdapter implements IIdentifierResolverPort {
  private readonly parser = new RegexAstBibtexParser();

  public async resolve(
    identifier: AcademicIdentifierVo,
  ): Promise<BibEntry | null> {
    if (identifier.isDoi()) {
      return this.resolveDoi(identifier.clean);
    }

    if (identifier.isArxiv()) {
      return this.resolveArxiv(identifier.clean);
    }

    return null;
  }

  /**
   * Resolves DOI via CrossRef Content Negotiation or REST API.
   */
  private async resolveDoi(cleanDoi: string): Promise<BibEntry | null> {
    try {
      // 1. Try CrossRef Content Negotiation (returns formatted BibTeX directly)
      const res = await fetch(
        `https://doi.org/${encodeURIComponent(cleanDoi)}`,
        {
          headers: {
            Accept: 'application/x-bibtex; charset=utf-8',
            'User-Agent': 'FluxManuscripts/1.0 (mailto:support@flux.local)',
          },
        },
      );

      if (res.ok) {
        const bibText = await res.text();
        const entries = this.parser.parse(bibText);
        if (entries.length > 0 && entries[0]) {
          return entries[0];
        }
      }
    } catch {
      // Network failure or offline
    }

    // 2. Fallback: Query CrossRef REST API for JSON metadata
    try {
      const jsonRes = await fetch(
        `https://api.crossref.org/works/${encodeURIComponent(cleanDoi)}`,
        {
          headers: { 'User-Agent': 'FluxManuscripts/1.0' },
        },
      );

      if (jsonRes.ok) {
        const data = await jsonRes.json();
        const item = data.message;
        if (item) {
          const title = item.title?.[0] || 'Untitled Document';
          // Publication year only; never invent one (no deposit date / current year fallback).
          const yearRaw =
            item['published-print']?.['date-parts']?.[0]?.[0] ||
            item['published-online']?.['date-parts']?.[0]?.[0] ||
            item.issued?.['date-parts']?.[0]?.[0] ||
            item.published?.['date-parts']?.[0]?.[0];
          const year = yearRaw ? String(yearRaw) : undefined;

          // Plain "Family, Given" names; organizations wrapped as {Name}
          const authors = (item.author || [])
            .map((a: any) => {
              if (a.family && a.given) return `${a.family}, ${a.given}`;
              if (a.family) return String(a.family);
              if (a.name) return `{${a.name}}`;
              return '';
            })
            .filter(Boolean)
            .join(' and ');
          const editors = (item.editor || [])
            .map((a: any) =>
              a.family && a.given
                ? `${a.family}, ${a.given}`
                : a.family || (a.name ? `{${a.name}}` : ''),
            )
            .filter(Boolean)
            .join(' and ');

          const containerTitle = item['container-title']?.[0];
          const mapping =
            CROSSREF_TYPE_MAP[item.type] ||
            (containerTitle
              ? { type: 'article', container: 'journal' }
              : { type: 'misc' });

          const fields: Record<string, string> = {
            title,
            author: authors || 'Unknown Author',
            doi: cleanDoi,
          };
          if (editors) fields.editor = editors;
          if (year) fields.year = year;
          if (mapping.container && containerTitle) {
            fields[mapping.container] = containerTitle;
          }
          if (item.volume) fields.volume = String(item.volume);
          if (item.issue) fields.number = String(item.issue);
          if (item.page) {
            fields.pages = String(item.page).replace(
              /\s*[-\u2010-\u2015]+\s*/g,
              '--',
            );
          }
          if (item.publisher) {
            if (mapping.type === 'techreport')
              fields.institution = item.publisher;
            else if (mapping.type === 'phdthesis')
              fields.school = item.publisher;
            else if (mapping.type !== 'article')
              fields.publisher = item.publisher;
          }
          if (item['publisher-location']) {
            fields.address = String(item['publisher-location']);
          }
          if (Array.isArray(item.ISSN) && item.ISSN[0])
            fields.issn = item.ISSN[0];
          if (Array.isArray(item.ISBN) && item.ISBN[0])
            fields.isbn = item.ISBN[0];
          if (item.URL) fields.url = String(item.URL);

          return new BibEntry({
            key: this.buildKey(
              item.author?.[0]?.family || item.author?.[0]?.name,
              year,
              title,
              `doi_${cleanDoi}`,
            ),
            entryType: mapping.type,
            fields,
            valueFormat: 'plain',
          });
        }
      }
    } catch {
      // Fallback
    }

    return null;
  }

  /**
   * Resolves arXiv ID via arXiv export API.
   */
  private async resolveArxiv(cleanArxivId: string): Promise<BibEntry | null> {
    try {
      const res = await fetch(
        `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(cleanArxivId)}`,
      );

      if (res.ok) {
        const xmlText = await res.text();
        const entryMatch = xmlText.match(/<entry>([\s\S]*?)<\/entry>/i);
        if (entryMatch && entryMatch[1]) {
          const entryXml = entryMatch[1];

          const titleMatch = entryXml.match(/<title>([\s\S]*?)<\/title>/i);
          const title = titleMatch
            ? decodeXmlEntities(titleMatch[1].replace(/\s+/g, ' ').trim())
            : 'arXiv Preprint';

          const publishedMatch = entryXml.match(/<published>(\d{4})/i);
          const year = publishedMatch ? publishedMatch[1] : undefined;

          const rawAuthors: string[] = [];
          const authorRegex = /<author>\s*<name>([^<]+)<\/name>/gi;
          let aMatch: RegExpExecArray | null;
          while ((aMatch = authorRegex.exec(entryXml)) !== null) {
            if (aMatch[1]) rawAuthors.push(decodeXmlEntities(aMatch[1].trim()));
          }
          const authors = rawAuthors.map(toFamilyGiven);

          // Real primary category from the Atom feed (no hard-coded default)
          const primaryMatch = entryXml.match(
            /<arxiv:primary_category[^>]*\bterm="([^"]+)"/i,
          );
          const doiMatch = entryXml.match(
            /<arxiv:doi[^>]*>([^<]+)<\/arxiv:doi>/i,
          );

          const fields: Record<string, string> = {
            title,
            author: authors.join(' and ') || 'Unknown Author',
            eprint: cleanArxivId,
            archiveprefix: 'arXiv',
            url: `https://arxiv.org/abs/${cleanArxivId}`,
          };
          if (year) fields.year = year;
          if (primaryMatch?.[1]) fields.primaryclass = primaryMatch[1];
          if (doiMatch?.[1]) fields.doi = doiMatch[1].trim();

          const firstFamily = authors[0]?.split(',')[0];
          return new BibEntry({
            key: this.buildKey(
              firstFamily,
              year,
              title,
              `arxiv_${cleanArxivId}`,
            ),
            entryType: 'misc',
            fields,
            valueFormat: 'plain',
          });
        }
      }
    } catch {
      // Network failure
    }

    return null;
  }

  /**
   * Builds a citation key "<family><year><firstTitleWord>" restricted to
   * [A-Za-z0-9_:.-]; falls back to a sanitized identifier-based key.
   */
  private buildKey(
    family: string | undefined,
    year: string | undefined,
    title: string,
    fallback: string,
  ): string {
    const STOP = new Set(['a', 'an', 'the', 'on', 'of', 'in', 'for', 'and']);
    const firstWord =
      title
        .split(/\s+/)
        .map((w) => sanitizeCitationKey(w).replace(/[:.-]/g, '').toLowerCase())
        .find((w) => w.length > 0 && !STOP.has(w)) || '';
    const fam = sanitizeCitationKey(family || '')
      .replace(/[:.-]/g, '')
      .toLowerCase();
    const key = `${fam}${year || ''}${firstWord}`;
    if (fam && key) return key;
    return sanitizeCitationKey(fallback.replace(/\//g, '_')) || 'ref';
  }
}

/** "Ashish Vaswani" -> "Vaswani, Ashish"; keeps lowercase particles with the family name. */
function toFamilyGiven(name: string): string {
  if (name.includes(',')) return name;
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return name;
  // First lowercase token after the first word starts the family part (von/van der/de la ...)
  let idx = parts.findIndex((p, i) => i > 0 && /^\p{Ll}/u.test(p));
  if (idx === -1) idx = parts.length - 1;
  const given = parts.slice(0, idx).join(' ');
  const family = parts.slice(idx).join(' ');
  return given ? `${family}, ${given}` : family;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) =>
      String.fromCodePoint(parseInt(h, 16)),
    )
    .replace(/&amp;/g, '&');
}
